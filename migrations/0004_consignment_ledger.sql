-- Consignment subledger: replaces LOFI's hand-kept consignment spreadsheet.
-- One row per consigned item line in a sale or refund, fed from the same
-- normalised sales as the payout split. Re-importing a payout updates rows in
-- place (entry_key); rows marked posted are never recalculated.

ALTER TABLE consignors ADD COLUMN notes TEXT;
ALTER TABLE consignors ADD COLUMN active_from TEXT;   -- recorded only; rules aren't versioned yet
ALTER TABLE consignors ADD COLUMN active_to TEXT;

CREATE TABLE consignment_sales (
  entry_key               TEXT PRIMARY KEY,             -- channel|source txn|line item|sale or refund
  channel                 TEXT    NOT NULL,
  payout_id               TEXT    NOT NULL,
  order_id                TEXT    NOT NULL,
  order_name              TEXT,
  line_item_id            TEXT    NOT NULL,
  source_transaction_id   TEXT,
  sku                     TEXT,
  consignor_id            INTEGER REFERENCES consignors(id),
  kind                    TEXT    NOT NULL,             -- 'sale' | 'refund'
  sale_date               TEXT    NOT NULL,
  gross_sale_cents        INTEGER NOT NULL,             -- commission basis: item after discounts, excl. shipping
  shipping_cents          INTEGER NOT NULL DEFAULT 0,   -- information only
  discount_cents          INTEGER NOT NULL DEFAULT 0,
  commission_basis        TEXT    NOT NULL,
  commission_type         TEXT,
  commission_value        REAL,
  commission_cents        INTEGER,
  commission_gst_cents    INTEGER,
  consignor_payable_cents INTEGER,
  accounting_period       TEXT    NOT NULL,             -- YYYY-MM of the payout
  status                  TEXT    NOT NULL,             -- 'calculated' | 'incomplete'
  problem                 TEXT,
  journal_status          TEXT    NOT NULL DEFAULT 'unposted',  -- 'unposted' | 'posted' (milestone 2)
  first_recorded_at       TEXT    NOT NULL,
  last_calculated_at      TEXT    NOT NULL
);
CREATE INDEX idx_consignment_sales_period ON consignment_sales (accounting_period, consignor_id);
CREATE INDEX idx_consignment_sales_payout ON consignment_sales (channel, payout_id);
