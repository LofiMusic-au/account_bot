-- Milestone 2: QuickBooks posting (one journal + one clearing->bank transfer
-- per payout). Dry-run by default; nothing is written to QuickBooks unless
-- QBO_MODE is set to sandbox or live AND a person approves the payout.

-- One row per payout: its current preview, approval and what was posted.
-- A posted payout's posted_* columns never change; corrections are separate
-- adjustment entries (qbo_adjustments).
CREATE TABLE qbo_postings (
  channel               TEXT NOT NULL,
  payout_id             TEXT NOT NULL,
  status                TEXT NOT NULL,      -- not_ready | ready_for_review | approved | posting | journal_posted | posted | failed | adjustment_required
  gate_reasons_json     TEXT NOT NULL,      -- why it can't be posted (empty when ready)
  preview_json          TEXT NOT NULL,      -- current journal + transfer preview
  preview_fingerprint   TEXT NOT NULL,
  approved_fingerprint  TEXT,
  approved_at           TEXT,
  approved_by           TEXT,
  posted_fingerprint    TEXT,
  posted_preview_json   TEXT,               -- exactly what was posted (immutable)
  journal_id            TEXT,
  journal_doc_number    TEXT,
  transfer_id           TEXT,
  posted_at             TEXT,
  posting_started_at    TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (channel, payout_id)
);

-- Append-only audit trail of everything that happened to a payout's posting.
CREATE TABLE qbo_posting_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL,
  payout_id   TEXT NOT NULL,
  at          TEXT NOT NULL,
  event       TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX idx_qbo_events_payout ON qbo_posting_events (channel, payout_id, id);

-- Adjusting entries for payouts that changed after posting. Linked to the
-- original journal; the original is never edited.
CREATE TABLE qbo_adjustments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  channel             TEXT NOT NULL,
  payout_id           TEXT NOT NULL,
  seq                 INTEGER NOT NULL,     -- 1, 2, ... per payout
  original_journal_id TEXT NOT NULL,
  status              TEXT NOT NULL,        -- pending | approved | posted | superseded
  reason              TEXT NOT NULL,
  preview_json        TEXT NOT NULL,
  from_fingerprint    TEXT NOT NULL,
  to_fingerprint      TEXT NOT NULL,
  journal_id          TEXT,
  created_at          TEXT NOT NULL,
  approved_at         TEXT,
  posted_at           TEXT,
  UNIQUE (channel, payout_id, seq)
);

-- LOFI's QuickBooks IDs for each logical account and tax code. Filled in
-- once the real chart of accounts is chosen; business logic never holds IDs.
CREATE TABLE qbo_account_map (
  account_key    TEXT PRIMARY KEY,
  qbo_account_id TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE qbo_tax_code_map (
  tax_code_name   TEXT PRIMARY KEY,
  qbo_tax_code_id TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Intuit rotates refresh tokens; the latest one is kept here (never in Git).
CREATE TABLE qbo_tokens (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
