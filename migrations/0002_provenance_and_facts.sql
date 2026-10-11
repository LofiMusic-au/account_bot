-- Milestone 1 foundation: stock facts, source provenance, idempotent ingestion.

-- Stock facts. Tax treatment is derived from these; it is never stored.
ALTER TABLE stock_items ADD COLUMN item_condition TEXT;        -- 'new' | 'secondhand' | NULL (unknown)
ALTER TABLE sku_prefix_rules ADD COLUMN item_condition TEXT;
-- acquired_from now also accepts 'other' (always reviewed).

-- Consignor GST status with an explicit "unknown". Existing rows were entered
-- through a form that forced a yes/no choice, so they are carried across.
ALTER TABLE consignors ADD COLUMN gst_status TEXT;              -- 'registered' | 'not_registered' | NULL (unknown)
UPDATE consignors SET gst_status = CASE WHEN gst_registered = 1 THEN 'registered' ELSE 'not_registered' END;

-- Facts recorded by staff against one order, e.g. the destination of a
-- local-pickup order that the platform sent without a shipping address.
CREATE TABLE order_facts (
  channel             TEXT NOT NULL,
  order_id            TEXT NOT NULL,
  destination_country TEXT,                                     -- ISO-2
  note                TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, order_id)
);

-- One row per platform payout, as received. normalised_json lets a report be
-- rebuilt after a fact is corrected, without calling the platform again.
CREATE TABLE source_payouts (
  channel           TEXT    NOT NULL,
  payout_id         TEXT    NOT NULL,
  payout_date       TEXT    NOT NULL,
  raw_amount        TEXT    NOT NULL,
  raw_currency      TEXT    NOT NULL,
  payload_json      TEXT    NOT NULL,
  normalised_json   TEXT    NOT NULL,
  transaction_count INTEGER NOT NULL,
  first_ingested_at TEXT    NOT NULL,
  last_ingested_at  TEXT    NOT NULL,
  fetch_count       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (channel, payout_id)
);

-- One row per platform transaction. Keyed on the platform's own IDs, so
-- re-fetching a payout updates rows instead of adding duplicates.
CREATE TABLE source_transactions (
  channel           TEXT NOT NULL,
  transaction_type  TEXT NOT NULL,
  transaction_id    TEXT NOT NULL,
  payout_id         TEXT NOT NULL,
  order_id          TEXT,
  raw_amount        TEXT NOT NULL,
  raw_currency      TEXT NOT NULL,
  source_timestamp  TEXT NOT NULL,
  payload_json      TEXT NOT NULL,                              -- buyer details removed
  payload_hash      TEXT NOT NULL,
  first_ingested_at TEXT NOT NULL,
  last_ingested_at  TEXT NOT NULL,
  changed_at        TEXT,                                       -- set when a re-fetch returned different data
  PRIMARY KEY (channel, transaction_type, transaction_id)
);
CREATE INDEX idx_source_transactions_payout ON source_transactions (channel, payout_id);

-- Selected order fields (no names, emails or street addresses).
CREATE TABLE source_orders (
  channel           TEXT NOT NULL,
  order_id          TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  first_ingested_at TEXT NOT NULL,
  last_ingested_at  TEXT NOT NULL,
  PRIMARY KEY (channel, order_id)
);

-- Report summary columns for the payouts list.
ALTER TABLE payout_reports ADD COLUMN provisional INTEGER NOT NULL DEFAULT 1;
ALTER TABLE payout_reports ADD COLUMN blocking_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payout_reports ADD COLUMN signoff_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payout_reports ADD COLUMN scenario_summary TEXT;
ALTER TABLE payout_reports ADD COLUMN first_generated_at TEXT;
ALTER TABLE payout_reports ADD COLUMN run_count INTEGER NOT NULL DEFAULT 1;
