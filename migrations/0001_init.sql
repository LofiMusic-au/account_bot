-- LOFI reconciliation: control ledger.
-- QuickBooks stays the accounting system; this database only holds what eBay,
-- Shopify and QuickBooks don't know (who owns each item and how it's taxed)
-- and the history of payout reports.

-- People and businesses who consign gear to LOFI.
CREATE TABLE consignors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  contact          TEXT,
  gst_registered   INTEGER NOT NULL DEFAULT 0,          -- 0/1
  abn              TEXT,
  commission_type  TEXT    NOT NULL DEFAULT 'percent',  -- 'percent' | 'fixed'
  commission_value REAL    NOT NULL DEFAULT 0,          -- 20 = 20%, or fixed AUD
  agreement_type   TEXT    NOT NULL DEFAULT 'agency',   -- 'agency' | '153B'
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per stock item (keyed by the SKU used on eBay/Shopify).
-- Recorded at intake so the GST scenario is known before the item sells.
CREATE TABLE stock_items (
  sku               TEXT PRIMARY KEY,
  title             TEXT,
  ownership         TEXT NOT NULL,             -- 'owned' | 'consignment'
  acquired_from     TEXT,                      -- 'registered_supplier' | 'private_seller' | 'trade_in'
  purchase_cents    INTEGER,                   -- what LOFI paid (A2/A3, Division 66)
  purchase_date     TEXT,
  seller_name       TEXT,                      -- Division 66 records
  seller_address    TEXT,
  seller_description TEXT,
  quantity          INTEGER DEFAULT 1,
  consignor_id      INTEGER REFERENCES consignors(id),
  commission_type   TEXT,                      -- overrides consignor default
  commission_value  REAL,
  override_scenario TEXT,                      -- manual override, wins over every rule
  notes             TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Defaults by SKU prefix, for stock that has no individual record yet.
-- e.g. prefix 'ADAPT-' -> owned, registered_supplier.
-- Longest matching prefix wins. An individual stock_items row always wins.
CREATE TABLE sku_prefix_rules (
  prefix            TEXT PRIMARY KEY,
  description       TEXT,
  ownership         TEXT NOT NULL,
  acquired_from     TEXT,
  consignor_id      INTEGER REFERENCES consignors(id),
  commission_type   TEXT,
  commission_value  REAL
);

-- One report per payout. Report-only: nothing here is posted to QuickBooks.
CREATE TABLE payout_reports (
  channel          TEXT    NOT NULL,           -- 'ebay' | 'shopify'
  payout_id        TEXT    NOT NULL,
  payout_date      TEXT    NOT NULL,
  net_cents        INTEGER NOT NULL,           -- what hit the bank
  expected_cents   INTEGER NOT NULL,           -- rebuilt from transactions
  difference_cents INTEGER NOT NULL,
  status           TEXT    NOT NULL,           -- 'ready' | 'needs_review' | 'unbalanced'
  sale_count       INTEGER NOT NULL,
  review_count     INTEGER NOT NULL,
  gst_cents        INTEGER NOT NULL,
  report_json      TEXT    NOT NULL,
  generated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, payout_id)
);
CREATE INDEX idx_payout_reports_date ON payout_reports (payout_date DESC);
