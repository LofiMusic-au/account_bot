// Posting workflow: preview -> review -> approve -> post journal -> verify ->
// post transfer -> verify -> posted. Idempotent: one payout = at most one
// journal (DocNumber EB-/SP-<payout>) and one transfer (PrivateNote
// reference). Before creating anything it looks for what already exists, in
// our records and in QuickBooks, so a retry after an ambiguous failure never
// creates a second transaction. Posted history is immutable: a change after
// posting becomes a linked adjusting journal.

import type { PayoutReport } from "../reconcile";
import { gstInclusive } from "../money";
import { ACCOUNT_DEFS, taxRateBp, type AccountKey, type TaxCodeName } from "./accounts";
import { missingIds, toQboJournal, toQboTransfer, type IdMaps, type QboGateway } from "./gateway";
import { buildJournalPreview, fingerprint, gateReasons, type JournalLine, type JournalPreview } from "./journal";

export type PostingStatus =
  | "not_ready"
  | "ready_for_review"
  | "approved"
  | "posting"
  | "journal_posted"
  | "posted"
  | "failed"
  | "adjustment_required";

export interface PostingRow {
  channel: string;
  payout_id: string;
  status: PostingStatus;
  gate_reasons_json: string;
  preview_json: string;
  preview_fingerprint: string;
  approved_fingerprint: string | null;
  approved_at: string | null;
  approved_by: string | null;
  posted_fingerprint: string | null;
  posted_preview_json: string | null;
  journal_id: string | null;
  journal_doc_number: string | null;
  transfer_id: string | null;
  posted_at: string | null;
  posting_started_at: string | null;
  attempt_count: number;
  last_error: string | null;
  updated_at: string;
}

export interface AdjustmentRow {
  id: number;
  channel: string;
  payout_id: string;
  seq: number;
  original_journal_id: string;
  status: "pending" | "approved" | "posted" | "superseded";
  reason: string;
  preview_json: string;
  from_fingerprint: string;
  to_fingerprint: string;
  journal_id: string | null;
  created_at: string;
  approved_at: string | null;
  posted_at: string | null;
}

const POSTED_STATES: PostingStatus[] = ["posting", "journal_posted", "posted", "adjustment_required"];

export async function logEvent(db: D1Database, channel: string, payoutId: string, event: string, detail?: unknown, now = new Date()) {
  await db
    .prepare("INSERT INTO qbo_posting_events (channel, payout_id, at, event, detail_json) VALUES (?, ?, ?, ?, ?)")
    .bind(channel, payoutId, now.toISOString(), event, detail === undefined ? null : JSON.stringify(detail))
    .run();
}

export async function getPosting(db: D1Database, channel: string, payoutId: string): Promise<PostingRow | null> {
  return db.prepare("SELECT * FROM qbo_postings WHERE channel = ? AND payout_id = ?").bind(channel, payoutId).first<PostingRow>();
}

export async function listEvents(db: D1Database, channel: string, payoutId: string, limit = 50) {
  return (
    await db
      .prepare("SELECT at, event, detail_json FROM qbo_posting_events WHERE channel = ? AND payout_id = ? ORDER BY id DESC LIMIT ?")
      .bind(channel, payoutId, limit)
      .all<{ at: string; event: string; detail_json: string | null }>()
  ).results;
}

export async function pendingAdjustment(db: D1Database, channel: string, payoutId: string): Promise<AdjustmentRow | null> {
  return db
    .prepare("SELECT * FROM qbo_adjustments WHERE channel = ? AND payout_id = ? AND status IN ('pending', 'approved') ORDER BY seq DESC LIMIT 1")
    .bind(channel, payoutId)
    .first<AdjustmentRow>();
}

/** The journal that turns what was posted into what should now be posted. */
export function adjustmentPreview(posted: JournalPreview, current: JournalPreview, seq: number): JournalPreview {
  const key = (l: JournalLine) => `${l.accountKey}|${l.taxCode ?? ""}`;
  const signed = (l: JournalLine) => (l.postingType === "Credit" ? 1 : -1) * l.amountCents;
  const delta = new Map<string, { line: JournalLine; cents: number }>();
  for (const l of current.lines) delta.set(key(l), { line: l, cents: (delta.get(key(l))?.cents ?? 0) + signed(l) });
  for (const l of posted.lines) {
    const d = delta.get(key(l)) ?? { line: l, cents: 0 };
    d.cents -= signed(l);
    delta.set(key(l), d);
  }
  const lines: JournalLine[] = [...delta.values()]
    .filter((d) => d.cents !== 0)
    .map((d) => ({
      ...d.line,
      postingType: d.cents > 0 ? "Credit" : "Debit",
      amountCents: Math.abs(d.cents),
      gstCents: taxRateBp(d.line.taxCode) === 1000 ? gstInclusive(Math.abs(d.cents)) : 0,
      description: `Adjustment ${seq}: ${d.line.description}`,
    }));
  const sum = (t: "Debit" | "Credit") => lines.filter((l) => l.postingType === t).reduce((a, l) => a + l.amountCents, 0);
  return {
    ...current,
    docNumber: `${posted.docNumber}-A${seq}`.slice(0, 21),
    memo: `Adjustment ${seq} to ${posted.docNumber} (${posted.memo})`,
    lines,
    totalDebitCents: sum("Debit"),
    totalCreditCents: sum("Credit"),
  };
}

/**
 * Bring a payout's posting record up to date with its latest report. Called
 * on every rebuild. Never touches what was posted.
 */
export async function refreshPosting(db: D1Database, r: PayoutReport, now = new Date()): Promise<PostingRow> {
  const ts = now.toISOString();
  const preview = buildJournalPreview(r);
  const fp = await fingerprint(preview);
  const reasons = gateReasons(r, preview);
  const row = await getPosting(db, r.channel, r.payoutId);

  let status: PostingStatus;
  let approvedFp = row?.approved_fingerprint ?? null;
  if (row && POSTED_STATES.includes(row.status) && row.posted_fingerprint) {
    // Posted: compare with what was posted; a difference needs an adjusting entry.
    const changed = fp !== row.posted_fingerprint;
    status = changed ? "adjustment_required" : "posted";
    if (changed) {
      const pending = await pendingAdjustment(db, r.channel, r.payoutId);
      if (!pending || pending.to_fingerprint !== fp) {
        if (pending) await db.prepare("UPDATE qbo_adjustments SET status = 'superseded' WHERE id = ?").bind(pending.id).run();
        const seq = ((await db.prepare("SELECT max(seq) AS s FROM qbo_adjustments WHERE channel = ? AND payout_id = ?").bind(r.channel, r.payoutId).first<{ s: number | null }>())?.s ?? 0) + 1;
        const lastPosted = await lastPostedPreview(db, row);
        const adj = adjustmentPreview(lastPosted, preview, seq);
        await db
          .prepare(
            `INSERT INTO qbo_adjustments (channel, payout_id, seq, original_journal_id, status, reason, preview_json, from_fingerprint, to_fingerprint, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
          )
          .bind(r.channel, r.payoutId, seq, row.journal_id ?? "", "The payout's accounting changed after it was posted", JSON.stringify(adj), row.posted_fingerprint, fp, ts)
          .run();
        await logEvent(db, r.channel, r.payoutId, "adjustment_required", { seq, from: row.posted_fingerprint, to: fp }, now);
      }
    } else {
      const pending = await pendingAdjustment(db, r.channel, r.payoutId);
      if (pending) {
        await db.prepare("UPDATE qbo_adjustments SET status = 'superseded' WHERE id = ?").bind(pending.id).run();
        await logEvent(db, r.channel, r.payoutId, "adjustment_withdrawn", { seq: pending.seq }, now);
      }
    }
    if (row.status === "journal_posted" || row.status === "posting") status = row.status; // partial post: finish it first
  } else if (row && (row.status === "approved" || row.status === "failed") && row.approved_fingerprint === fp && reasons.length === 0) {
    status = row.status;
  } else {
    if (row?.approved_fingerprint && row.approved_fingerprint !== fp) {
      approvedFp = null;
      await logEvent(db, r.channel, r.payoutId, "approval_invalidated", { reason: "the preview changed after approval" }, now);
    }
    status = reasons.length ? "not_ready" : "ready_for_review";
    if (status === "not_ready") approvedFp = null;
  }

  await db
    .prepare(
      `INSERT INTO qbo_postings (channel, payout_id, status, gate_reasons_json, preview_json, preview_fingerprint, approved_fingerprint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, payout_id) DO UPDATE SET status = excluded.status, gate_reasons_json = excluded.gate_reasons_json,
         preview_json = excluded.preview_json, preview_fingerprint = excluded.preview_fingerprint,
         approved_fingerprint = excluded.approved_fingerprint,
         approved_at = CASE WHEN excluded.approved_fingerprint IS NULL THEN NULL ELSE qbo_postings.approved_at END,
         approved_by = CASE WHEN excluded.approved_fingerprint IS NULL THEN NULL ELSE qbo_postings.approved_by END,
         updated_at = excluded.updated_at`,
    )
    .bind(r.channel, r.payoutId, status, JSON.stringify(reasons), JSON.stringify(preview), fp, approvedFp, ts)
    .run();
  if (!row) await logEvent(db, r.channel, r.payoutId, "preview_created", { status, fingerprint: fp }, now);
  else if (row.status !== status) await logEvent(db, r.channel, r.payoutId, "status_changed", { from: row.status, to: status }, now);
  return (await getPosting(db, r.channel, r.payoutId))!;
}

/** The accounting as last posted: the original journal plus any posted adjustments. */
async function lastPostedPreview(db: D1Database, row: PostingRow): Promise<JournalPreview> {
  const base = JSON.parse(row.posted_preview_json!) as JournalPreview;
  const posted = (
    await db
      .prepare("SELECT preview_json FROM qbo_adjustments WHERE channel = ? AND payout_id = ? AND status = 'posted' ORDER BY seq")
      .bind(row.channel, row.payout_id)
      .all<{ preview_json: string }>()
  ).results;
  if (!posted.length) return base;
  // Fold adjustments into the original.
  const lines = new Map<string, JournalLine>();
  const signed = (l: JournalLine) => (l.postingType === "Credit" ? 1 : -1) * l.amountCents;
  const fold = (ls: JournalLine[]) => {
    for (const l of ls) {
      const k = `${l.accountKey}|${l.taxCode ?? ""}`;
      const prev = lines.get(k);
      const cents = (prev ? signed(prev) : 0) + signed(l);
      lines.set(k, { ...(prev ?? l), postingType: cents >= 0 ? "Credit" : "Debit", amountCents: Math.abs(cents) });
    }
  };
  fold(base.lines);
  for (const a of posted) fold((JSON.parse(a.preview_json) as JournalPreview).lines);
  return { ...base, lines: [...lines.values()].filter((l) => l.amountCents !== 0) };
}

export async function approvePosting(db: D1Database, channel: string, payoutId: string, by: string, now = new Date()): Promise<PostingRow> {
  const row = await getPosting(db, channel, payoutId);
  if (!row) throw new Error("No posting preview for this payout yet");
  if (row.status !== "ready_for_review") throw new Error(`Can't approve a payout that is ${row.status.replace(/_/g, " ")}`);
  await db
    .prepare("UPDATE qbo_postings SET status = 'approved', approved_fingerprint = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE channel = ? AND payout_id = ?")
    .bind(row.preview_fingerprint, now.toISOString(), by, now.toISOString(), channel, payoutId)
    .run();
  await logEvent(db, channel, payoutId, "approved", { by, fingerprint: row.preview_fingerprint }, now);
  return (await getPosting(db, channel, payoutId))!;
}

export async function loadIdMaps(db: D1Database): Promise<IdMaps> {
  const a = (await db.prepare("SELECT account_key, qbo_account_id FROM qbo_account_map").all<{ account_key: AccountKey; qbo_account_id: string }>()).results;
  const t = (await db.prepare("SELECT tax_code_name, qbo_tax_code_id FROM qbo_tax_code_map").all<{ tax_code_name: TaxCodeName; qbo_tax_code_id: string }>()).results;
  return { accounts: new Map(a.map((x) => [x.account_key, x.qbo_account_id])), taxCodes: new Map(t.map((x) => [x.tax_code_name, x.qbo_tax_code_id])) };
}

const LOCK_MS = 5 * 60_000;

/**
 * Post an approved payout: journal, then transfer. Safe to call again after
 * any failure: it finishes whatever is missing and never creates a second
 * journal or transfer.
 */
export async function postPayout(
  db: D1Database,
  gw: QboGateway,
  report: PayoutReport,
  now = new Date(),
): Promise<PostingRow> {
  const { channel, payoutId } = report;
  if (gw.mode === "dry_run") throw new Error("Posting is switched off (dry-run mode)");
  const row = await getPosting(db, channel, payoutId);
  if (!row) throw new Error("No posting preview for this payout");
  if (row.status === "posted") return row; // nothing to do
  if (!["approved", "failed", "journal_posted", "posting"].includes(row.status)) {
    throw new Error(`Can't post a payout that is ${row.status.replace(/_/g, " ")}; it needs approval first`);
  }
  if (row.status === "posting" && row.posting_started_at && now.getTime() - Date.parse(row.posting_started_at) < LOCK_MS) {
    throw new Error("Posting is already in progress for this payout");
  }
  const preview = buildJournalPreview(report);
  const fp = await fingerprint(preview);
  const reasons = gateReasons(report, preview);
  if (reasons.length) throw new Error(`Blocked by the posting gate: ${reasons.join("; ")}`);
  if (!row.journal_id && fp !== row.approved_fingerprint) throw new Error("The preview changed since it was approved; review and approve it again");
  // Once the journal exists, the transfer follows what was posted.
  const toPost: JournalPreview = row.journal_id && row.posted_preview_json ? JSON.parse(row.posted_preview_json) : preview;
  const ids = await loadIdMaps(db);
  const miss = missingIds(toPost, ids);
  if (miss.length) throw new Error(`QuickBooks IDs not configured: ${miss.join(", ")}`);

  const ts = now.toISOString();
  await db
    .prepare("UPDATE qbo_postings SET status = 'posting', posting_started_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE channel = ? AND payout_id = ?")
    .bind(ts, ts, channel, payoutId)
    .run();
  await logEvent(db, channel, payoutId, "posting_started", { mode: gw.mode, attempt: row.attempt_count + 1 }, now);

  let journalId = row.journal_id;
  try {
    if (!journalId) {
      const existing = await gw.findJournalByDocNumber(toPost.docNumber);
      if (existing) {
        journalId = existing.id;
        await logEvent(db, channel, payoutId, "journal_found_in_quickbooks", { journalId, docNumber: toPost.docNumber }, now);
      } else {
        journalId = (await gw.createJournal(toQboJournal(toPost, ids))).id;
        await logEvent(db, channel, payoutId, "journal_created", { journalId, docNumber: toPost.docNumber }, now);
      }
      const check = await gw.getJournal(journalId);
      if (!check) throw new Error(`Journal ${journalId} couldn't be read back from QuickBooks`);
      if (check.totalCents !== toPost.totalDebitCents) throw new Error(`Journal ${journalId} total ${check.totalCents} doesn't match the preview ${toPost.totalDebitCents}`);
      await db
        .prepare(
          `UPDATE qbo_postings SET status = 'journal_posted', journal_id = ?, journal_doc_number = ?, posted_fingerprint = ?, posted_preview_json = ?, updated_at = ?
           WHERE channel = ? AND payout_id = ?`,
        )
        .bind(journalId, toPost.docNumber, fp, JSON.stringify(toPost), ts, channel, payoutId)
        .run();
    }
    let transferId = row.transfer_id;
    if (!transferId) {
      const existing = await gw.findTransfer(toPost.transfer.reference, toPost.transfer.txnDate, toPost.transfer.amountCents);
      if (existing) {
        transferId = existing.id;
        await logEvent(db, channel, payoutId, "transfer_found_in_quickbooks", { transferId }, now);
      } else {
        transferId = (await gw.createTransfer(toQboTransfer(toPost, ids))).id;
        await logEvent(db, channel, payoutId, "transfer_created", { transferId, amountCents: toPost.transfer.amountCents }, now);
      }
      const t = await gw.getTransfer(transferId);
      if (!t || t.amountCents !== toPost.transfer.amountCents) throw new Error(`Transfer ${transferId} couldn't be verified in QuickBooks`);
    }
    await db
      .prepare("UPDATE qbo_postings SET status = 'posted', transfer_id = ?, posted_at = ?, last_error = NULL, posting_started_at = NULL, updated_at = ? WHERE channel = ? AND payout_id = ?")
      .bind(transferId, ts, ts, channel, payoutId)
      .run();
    await logEvent(db, channel, payoutId, "posted", { journalId, transferId }, now);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    const after = await getPosting(db, channel, payoutId);
    // Journal in QuickBooks but transfer missing: a recoverable partial post.
    const status: PostingStatus = after?.journal_id ? "journal_posted" : "failed";
    await db
      .prepare("UPDATE qbo_postings SET status = ?, last_error = ?, posting_started_at = NULL, updated_at = ? WHERE channel = ? AND payout_id = ?")
      .bind(status, msg, ts, channel, payoutId)
      .run();
    await logEvent(db, channel, payoutId, "posting_failed", { status, error: msg }, now);
  }
  return (await getPosting(db, channel, payoutId))!;
}

export async function approveAdjustment(db: D1Database, channel: string, payoutId: string, by: string, now = new Date()) {
  const adj = await pendingAdjustment(db, channel, payoutId);
  if (!adj || adj.status !== "pending") throw new Error("No pending adjustment to approve");
  await db.prepare("UPDATE qbo_adjustments SET status = 'approved', approved_at = ? WHERE id = ?").bind(now.toISOString(), adj.id).run();
  await logEvent(db, channel, payoutId, "adjustment_approved", { seq: adj.seq, by }, now);
}

/** Post an approved adjusting journal, linked to the original. Idempotent by its DocNumber. */
export async function postAdjustment(db: D1Database, gw: QboGateway, channel: string, payoutId: string, now = new Date()) {
  if (gw.mode === "dry_run") throw new Error("Posting is switched off (dry-run mode)");
  const adj = await pendingAdjustment(db, channel, payoutId);
  if (!adj || adj.status !== "approved") throw new Error("No approved adjustment to post");
  const p = JSON.parse(adj.preview_json) as JournalPreview;
  if (p.totalDebitCents !== p.totalCreditCents) throw new Error("The adjustment doesn't balance");
  const ids = await loadIdMaps(db);
  const existing = await gw.findJournalByDocNumber(p.docNumber);
  const journalId = existing?.id ?? (await gw.createJournal(toQboJournal({ ...p, transfer: { ...p.transfer, toKey: p.transfer.toKey } }, ids))).id;
  const ts = now.toISOString();
  await db.prepare("UPDATE qbo_adjustments SET status = 'posted', journal_id = ?, posted_at = ? WHERE id = ?").bind(journalId, ts, adj.id).run();
  await db
    .prepare("UPDATE qbo_postings SET status = 'posted', posted_fingerprint = ?, updated_at = ? WHERE channel = ? AND payout_id = ?")
    .bind(adj.to_fingerprint, ts, channel, payoutId)
    .run();
  await logEvent(db, channel, payoutId, "adjustment_posted", { seq: adj.seq, journalId, original: adj.original_journal_id }, now);
}

export const accountLabel = (k: AccountKey) => ACCOUNT_DEFS[k].name;
