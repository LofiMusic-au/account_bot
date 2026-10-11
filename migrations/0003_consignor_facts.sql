-- Consignor facts, made explicit before live data:
--   * agreement_type may now be unknown (NULL). It used to default to
--     'agency', which silently encoded an accounting conclusion for any
--     GST-registered consignor whose agreement wasn't recorded.
--   * GST registration is specifically *Australian* GST registration. A
--     consignor's VAT/GST status in another country is a different fact
--     and is not recorded or inferred.
--   * country (ISO-2) is recorded, and australian_gst_basis says whether the
--     registration answer was recorded by a person or defaulted at intake
--     because the consignor is overseas.
--
-- Existing agreement types are reset to unknown: the old form pre-selected
-- "Agency", so a stored 'agency' can't be told apart from a default. Nothing
-- had been deployed when this migration was written.
--
-- SQLite can't drop a NOT NULL default in place, so the table is rebuilt.
-- defer_foreign_keys lets stock_items / sku_prefix_rules keep pointing at
-- consignors(id) across the rebuild (Cloudflare's documented pattern).

PRAGMA defer_foreign_keys = true;

CREATE TABLE consignors_new (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  name                      TEXT    NOT NULL,
  contact                   TEXT,
  country                   TEXT,                             -- ISO-2, NULL = not recorded
  australian_gst_registered INTEGER,                          -- 1 / 0 / NULL = unknown
  australian_gst_basis      TEXT,                             -- 'recorded' | 'intake_default_overseas' | NULL
  abn                       TEXT,
  commission_type           TEXT    NOT NULL DEFAULT 'percent',
  commission_value          REAL    NOT NULL DEFAULT 0,
  agreement_type            TEXT,                             -- 'agency' | '153B' | NULL = unknown
  created_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO consignors_new (id, name, contact, country, australian_gst_registered, australian_gst_basis, abn,
                            commission_type, commission_value, agreement_type, created_at)
SELECT id, name, contact, NULL,
       CASE gst_status WHEN 'registered' THEN 1 WHEN 'not_registered' THEN 0 ELSE NULL END,
       CASE WHEN gst_status IS NULL THEN NULL ELSE 'recorded' END,
       abn, commission_type, commission_value, NULL, created_at
FROM consignors;

DROP TABLE consignors;
ALTER TABLE consignors_new RENAME TO consignors;

PRAGMA defer_foreign_keys = false;
