-- Shadow consignment ledger, reworked to mirror Jess's manual ledger:
--   Sale - actual postage - marketplace/payment fees - repairs - other agreed
--   costs = distributable NET, then split across the parties of a settlement
--   rule (e.g. 65/25/10, 65/25/5/5, 75/20/5, 50/50).
-- SHADOW MODE: provisional figures for comparison with Jess's ledger only.
-- The 0004 consignment_sales table was prototype scaffolding (commission off
-- the item price, never authoritative, nothing posted) and is replaced.

CREATE TABLE settlement_rules (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  name                      TEXT    NOT NULL,             -- e.g. "65/25/10"
  deduct_postage            INTEGER NOT NULL DEFAULT 1,
  deduct_fees               INTEGER NOT NULL DEFAULT 1,
  deduct_repairs            INTEGER NOT NULL DEFAULT 1,
  deduct_other              INTEGER NOT NULL DEFAULT 1,
  include_shipping_charged  INTEGER NOT NULL DEFAULT 1,   -- sale includes shipping the buyer paid
  bas_treatment             TEXT    NOT NULL DEFAULT 'unconfirmed', -- 'unconfirmed' | 'gst_on_lofi_share' | 'none'
  notes                     TEXT,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The parties a rule's NET is shared between. Fixed amounts come off first;
-- the rest is shared by the percentage parties (shares sum to 100%).
CREATE TABLE settlement_rule_parties (
  rule_id     INTEGER NOT NULL REFERENCES settlement_rules(id),
  position    INTEGER NOT NULL,
  role        TEXT    NOT NULL,                           -- 'consignor' | 'lofi' | 'partner'
  name        TEXT    NOT NULL,
  share_bp    INTEGER,                                    -- basis points: 6500 = 65%
  fixed_cents INTEGER,
  PRIMARY KEY (rule_id, position)
);

ALTER TABLE consignors ADD COLUMN settlement_rule_id INTEGER REFERENCES settlement_rules(id);
ALTER TABLE stock_items ADD COLUMN settlement_rule_id INTEGER REFERENCES settlement_rules(id);  -- per-item override

-- Costs entered by hand per sold item (until Australia Post / repairs are integrated).
-- Keyed on the sale line, so they survive re-imports and payout clears.
CREATE TABLE consignment_costs (
  channel       TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  line_item_id  TEXT NOT NULL,
  postage_cents INTEGER,                                  -- NULL = use the platform shipping-label cost, if any
  repairs_cents INTEGER,
  other_cents   INTEGER,
  note          TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, order_id, line_item_id)
);

DROP TABLE consignment_sales;

CREATE TABLE consignment_entries (
  entry_key               TEXT PRIMARY KEY,               -- channel|source txn|line item|sale or refund
  channel                 TEXT    NOT NULL,
  payout_id               TEXT    NOT NULL,
  order_id                TEXT    NOT NULL,
  order_name              TEXT,
  line_item_id            TEXT    NOT NULL,
  source_transaction_id   TEXT,
  sku                     TEXT,
  title                   TEXT,
  consignor_id            INTEGER REFERENCES consignors(id),
  settlement_rule_id      INTEGER REFERENCES settlement_rules(id),
  rule_snapshot_json      TEXT,                           -- the rule as applied, for audit
  kind                    TEXT    NOT NULL,               -- 'sale' | 'refund'
  sale_date               TEXT    NOT NULL,
  item_cents              INTEGER NOT NULL,
  shipping_charged_cents  INTEGER NOT NULL,
  gross_sale_cents        INTEGER NOT NULL,
  fees_cents              INTEGER NOT NULL,               -- marketplace + payment fees for this line
  postage_cents           INTEGER NOT NULL,
  postage_source          TEXT    NOT NULL,               -- 'manual' | 'shipping_label' | 'none'
  repairs_cents           INTEGER NOT NULL,
  other_cents             INTEGER NOT NULL,
  distributable_net_cents INTEGER,
  consignor_share_cents   INTEGER,
  lofi_share_cents        INTEGER,
  other_shares_cents      INTEGER,
  shares_json             TEXT,                           -- every party's share
  lofi_share_gst_cents    INTEGER,                        -- NULL while the rule's BAS treatment is unconfirmed
  bas_treatment           TEXT,
  accounting_period       TEXT    NOT NULL,
  status                  TEXT    NOT NULL,               -- 'calculated' | 'incomplete'
  problem                 TEXT,
  first_recorded_at       TEXT    NOT NULL,
  last_calculated_at      TEXT    NOT NULL
);
CREATE INDEX idx_consignment_entries_period ON consignment_entries (accounting_period, consignor_id);
CREATE INDEX idx_consignment_entries_payout ON consignment_entries (channel, payout_id);
