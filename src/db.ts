// D1 access: stock/consignor facts, source provenance, and payout reports.

import { saleScenarioCounts, type PayoutReport } from "./reconcile";
import type { StockResolver } from "./rules/engine";
import type {
  AcquiredFrom,
  Channel,
  Condition,
  Consignor,
  Issue,
  NormalisedPayout,
  Ownership,
  ScenarioCode,
  StockItem,
} from "./types";

export interface ConsignorRow {
  id: number;
  name: string;
  gst_registered: number;
  gst_status?: "registered" | "not_registered" | null;
  commission_type: "percent" | "fixed";
  commission_value: number;
  agreement_type: "agency" | "153B";
}
export interface StockRow {
  sku: string;
  title: string | null;
  ownership: Ownership;
  acquired_from: AcquiredFrom | null;
  item_condition?: Condition | null;
  purchase_cents: number | null;
  purchase_date: string | null;
  seller_name: string | null;
  seller_address: string | null;
  seller_description: string | null;
  consignor_id: number | null;
  commission_type: "percent" | "fixed" | null;
  commission_value: number | null;
  override_scenario: ScenarioCode | null;
}
export interface PrefixRow {
  prefix: string;
  ownership: Ownership;
  acquired_from: AcquiredFrom | null;
  item_condition?: Condition | null;
  consignor_id: number | null;
  commission_type: "percent" | "fixed" | null;
  commission_value: number | null;
}

const toConsignor = (r: ConsignorRow): Consignor => ({
  id: r.id,
  name: r.name,
  // gst_status is the source of truth; gst_registered only for rows from before migration 0002.
  gstRegistered:
    r.gst_status === undefined ? r.gst_registered === 1 : r.gst_status === null ? null : r.gst_status === "registered",
  commissionType: r.commission_type,
  commissionValue: r.commission_value,
  agreementType: r.agreement_type,
});

/** Pure resolver over preloaded rows: an item's own record beats the longest matching prefix. */
export function makeResolver(items: StockRow[], prefixes: PrefixRow[], consignors: ConsignorRow[]): StockResolver {
  const bySku = new Map(items.map((i) => [i.sku.trim().toUpperCase(), i]));
  const byId = new Map(consignors.map((c) => [c.id, toConsignor(c)]));
  const sortedPrefixes = [...prefixes].sort((a, b) => b.prefix.length - a.prefix.length);
  const consignorFor = (id: number | null) => (id ? (byId.get(id) ?? null) : null);
  return (sku) => {
    if (!sku) return null;
    const row = bySku.get(sku.trim().toUpperCase());
    if (row) {
      const isDiv66 = row.acquired_from === "private_seller" || row.acquired_from === "trade_in";
      return {
        sku: row.sku,
        title: row.title,
        ownership: row.ownership,
        acquiredFrom: row.acquired_from,
        condition: row.item_condition ?? null,
        purchaseCents: row.purchase_cents,
        consignor: consignorFor(row.consignor_id),
        consignorMissingId: row.consignor_id && !byId.has(row.consignor_id) ? row.consignor_id : null,
        commissionType: row.commission_type,
        commissionValue: row.commission_value,
        overrideScenario: row.override_scenario,
        source: "item",
        div66RecordComplete: isDiv66
          ? !!(row.seller_name && row.seller_address && row.seller_description && row.purchase_date && row.purchase_cents)
          : undefined,
      } satisfies StockItem;
    }
    const p = sortedPrefixes.find((x) => sku.trim().toUpperCase().startsWith(x.prefix.toUpperCase()));
    if (!p) return null;
    return {
      sku,
      ownership: p.ownership,
      acquiredFrom: p.acquired_from,
      condition: p.item_condition ?? null,
      purchaseCents: null,
      consignor: consignorFor(p.consignor_id),
      consignorMissingId: p.consignor_id && !byId.has(p.consignor_id) ? p.consignor_id : null,
      commissionType: p.commission_type,
      commissionValue: p.commission_value,
      source: "prefix",
      prefix: p.prefix,
    } satisfies StockItem;
  };
}

function skusIn(payout: NormalisedPayout): string[] {
  const skus = new Set<string>();
  for (const o of [...payout.sales, ...payout.refunds.flatMap((r) => (r.order ? [r.order] : []))]) {
    for (const l of o.lines) if (l.sku) skus.add(l.sku.trim().toUpperCase());
  }
  return [...skus];
}

async function inChunks<T>(db: D1Database, sql: (marks: string) => string, keys: string[], pre: unknown[] = []): Promise<T[]> {
  const out: T[] = [];
  // D1 caps bound parameters per statement; query in chunks.
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const r = await db.prepare(sql(chunk.map(() => "?").join(","))).bind(...pre, ...chunk).all<T>();
    out.push(...r.results);
  }
  return out;
}

export async function loadResolver(db: D1Database, payout: NormalisedPayout): Promise<StockResolver> {
  const items = await inChunks<StockRow>(db, (q) => `SELECT * FROM stock_items WHERE upper(sku) IN (${q})`, skusIn(payout));
  const prefixes = (await db.prepare("SELECT * FROM sku_prefix_rules").all<PrefixRow>()).results;
  const consignors = (await db.prepare("SELECT * FROM consignors").all<ConsignorRow>()).results;
  return makeResolver(items, prefixes, consignors);
}

// ------------------------------------------------------------- order facts

/** Apply destinations recorded by staff to orders the platform sent without one. */
export function applyOrderFacts(payout: NormalisedPayout, facts: Map<string, { destination_country: string | null }>): NormalisedPayout {
  const fix = <T extends { orderId: string; destinationCountry: string | null; shippingProgram: string }>(o: T): T => {
    const f = facts.get(o.orderId);
    if (!f?.destination_country || o.destinationCountry !== null) return o;
    const dest = f.destination_country.toUpperCase();
    return { ...o, destinationCountry: dest, destinationSource: "staff", shippingProgram: dest === "AU" ? "domestic" : "direct_export" };
  };
  return {
    ...payout,
    sales: payout.sales.map(fix),
    refunds: payout.refunds.map((r) => (r.order ? { ...r, order: fix(r.order) } : r)),
  };
}

export async function loadOrderFacts(db: D1Database, payout: NormalisedPayout) {
  const ids = [...new Set([...payout.sales.map((s) => s.orderId), ...payout.refunds.map((r) => r.orderId)])];
  const rows = await inChunks<{ order_id: string; destination_country: string | null }>(
    db,
    (q) => `SELECT order_id, destination_country FROM order_facts WHERE channel = ? AND order_id IN (${q})`,
    ids,
    [payout.channel],
  );
  return new Map(rows.map((r) => [r.order_id, r]));
}

export async function setOrderDestination(db: D1Database, channel: Channel, orderId: string, country: string): Promise<void> {
  const c = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw new Error("Destination must be a two-letter country code, e.g. AU or NZ");
  await db
    .prepare(
      `INSERT INTO order_facts (channel, order_id, destination_country, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (channel, order_id) DO UPDATE SET destination_country = excluded.destination_country, updated_at = excluded.updated_at`,
    )
    .bind(channel, orderId, c)
    .run();
}

// --------------------------------------------------------- source provenance

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The normalised payout without raw payloads (those live in source_transactions). */
function slim(p: NormalisedPayout): NormalisedPayout {
  return {
    ...p,
    raw: { payout: null, transactions: p.raw.transactions.map((t) => ({ ...t, payload: null })), orders: [] },
  };
}

/**
 * Store a fetched payout and its transactions and orders. Idempotent: every
 * row is keyed on the platform's own IDs, so a re-fetch updates in place.
 * Returns blocking issues for transactions already recorded under a
 * different payout, which would otherwise be counted twice. Those issues are
 * also stored with the payout so a later rebuild keeps them.
 */
export async function ingestPayout(db: D1Database, p: NormalisedPayout, now = new Date()): Promise<Issue[]> {
  const ts = now.toISOString();
  const issues: Issue[] = [];
  const ids = p.raw.transactions.map((t) => t.transactionId);
  const existing = await inChunks<{ transaction_type: string; transaction_id: string; payout_id: string }>(
    db,
    (q) => `SELECT transaction_type, transaction_id, payout_id FROM source_transactions WHERE channel = ? AND transaction_id IN (${q})`,
    [...new Set(ids)],
    [p.channel],
  );
  const types = new Map(p.raw.transactions.map((t) => [t.transactionId + "|" + t.transactionType, true]));
  for (const e of existing) {
    if (types.has(e.transaction_id + "|" + e.transaction_type) && e.payout_id !== p.payoutId) {
      issues.push({
        code: "transaction_in_other_payout",
        severity: "blocking",
        message: `Transaction ${e.transaction_id} (${e.transaction_type}) was already recorded in payout ${e.payout_id}`,
        transactionId: e.transaction_id,
      });
    }
  }

  const stmts: D1PreparedStatement[] = [];
  stmts.push(
    db
      .prepare(
        `INSERT INTO source_payouts (channel, payout_id, payout_date, raw_amount, raw_currency, payload_json, normalised_json,
           transaction_count, first_ingested_at, last_ingested_at, fetch_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (channel, payout_id) DO UPDATE SET payout_date = excluded.payout_date, raw_amount = excluded.raw_amount,
           raw_currency = excluded.raw_currency, payload_json = excluded.payload_json, normalised_json = excluded.normalised_json,
           transaction_count = excluded.transaction_count, last_ingested_at = excluded.last_ingested_at,
           fetch_count = source_payouts.fetch_count + 1`,
      )
      .bind(p.channel, p.payoutId, p.payoutDate, p.rawAmount, p.rawCurrency, JSON.stringify(p.raw.payout), JSON.stringify(slim({ ...p, issues: [...p.issues, ...issues] })), ids.length, ts, ts),
  );
  for (const t of p.raw.transactions) {
    // Only claim the row for this payout if no other payout owns it.
    const json = JSON.stringify(t.payload);
    stmts.push(
      db
        .prepare(
          `INSERT INTO source_transactions (channel, transaction_type, transaction_id, payout_id, order_id, raw_amount, raw_currency,
             source_timestamp, payload_json, payload_hash, first_ingested_at, last_ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (channel, transaction_type, transaction_id) DO UPDATE SET
             changed_at = CASE WHEN source_transactions.payload_hash <> excluded.payload_hash THEN excluded.last_ingested_at ELSE source_transactions.changed_at END,
             order_id = excluded.order_id, raw_amount = excluded.raw_amount, raw_currency = excluded.raw_currency,
             source_timestamp = excluded.source_timestamp, payload_json = excluded.payload_json, payload_hash = excluded.payload_hash,
             last_ingested_at = excluded.last_ingested_at
           WHERE source_transactions.payout_id = excluded.payout_id`,
        )
        .bind(
          p.channel,
          t.transactionType,
          t.transactionId,
          p.payoutId,
          t.orderId,
          t.rawAmount,
          t.rawCurrency,
          t.sourceTimestamp,
          json,
          await sha256(json),
          ts,
          ts,
        ),
    );
  }
  for (const o of p.raw.orders) {
    const json = JSON.stringify(o.payload);
    stmts.push(
      db
        .prepare(
          `INSERT INTO source_orders (channel, order_id, payload_json, payload_hash, first_ingested_at, last_ingested_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (channel, order_id) DO UPDATE SET payload_json = excluded.payload_json,
             payload_hash = excluded.payload_hash, last_ingested_at = excluded.last_ingested_at`,
        )
        .bind(p.channel, o.orderId, json, await sha256(json), ts, ts),
    );
  }
  await db.batch(stmts);
  return issues;
}

export async function loadStoredPayout(db: D1Database, channel: string, payoutId: string): Promise<NormalisedPayout | null> {
  const row = await db
    .prepare("SELECT normalised_json FROM source_payouts WHERE channel = ? AND payout_id = ?")
    .bind(channel, payoutId)
    .first<{ normalised_json: string }>();
  return row ? (JSON.parse(row.normalised_json) as NormalisedPayout) : null;
}

export interface SourceInfo {
  first_ingested_at: string;
  last_ingested_at: string;
  fetch_count: number;
  transaction_count: number;
  changed_transactions: number;
}

export async function sourceInfo(db: D1Database, channel: string, payoutId: string): Promise<SourceInfo | null> {
  return db
    .prepare(
      `SELECT first_ingested_at, last_ingested_at, fetch_count, transaction_count,
         (SELECT count(*) FROM source_transactions t WHERE t.channel = p.channel AND t.payout_id = p.payout_id AND t.changed_at IS NOT NULL) AS changed_transactions
       FROM source_payouts p WHERE channel = ? AND payout_id = ?`,
    )
    .bind(channel, payoutId)
    .first<SourceInfo>();
}

// ------------------------------------------------------------------ reports

export async function saveReport(db: D1Database, r: PayoutReport): Promise<void> {
  const summary = saleScenarioCounts(r);
  await db
    .prepare(
      `INSERT INTO payout_reports (channel, payout_id, payout_date, net_cents, expected_cents, difference_cents,
         status, sale_count, review_count, gst_cents, report_json, generated_at,
         provisional, blocking_count, signoff_count, scenario_summary, first_generated_at, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (channel, payout_id) DO UPDATE SET
         payout_date = excluded.payout_date, net_cents = excluded.net_cents, expected_cents = excluded.expected_cents,
         difference_cents = excluded.difference_cents, status = excluded.status, sale_count = excluded.sale_count,
         review_count = excluded.review_count, gst_cents = excluded.gst_cents, report_json = excluded.report_json,
         generated_at = excluded.generated_at, provisional = excluded.provisional, blocking_count = excluded.blocking_count,
         signoff_count = excluded.signoff_count, scenario_summary = excluded.scenario_summary,
         first_generated_at = COALESCE(payout_reports.first_generated_at, excluded.first_generated_at),
         run_count = payout_reports.run_count + 1`,
    )
    .bind(
      r.channel,
      r.payoutId,
      r.payoutDate,
      r.netCents,
      r.expectedCents,
      r.differenceCents,
      r.status,
      r.saleCount,
      r.reviewCount,
      r.totals.gstCents,
      JSON.stringify(r),
      r.generatedAt,
      r.provisional ? 1 : 0,
      r.blockingCount,
      r.signoffCount,
      JSON.stringify(summary),
      r.generatedAt,
    )
    .run();
}

export interface ReportSummary {
  channel: string;
  payout_id: string;
  payout_date: string;
  net_cents: number;
  expected_cents: number;
  difference_cents: number;
  status: string;
  sale_count: number;
  review_count: number;
  gst_cents: number;
  provisional: number;
  blocking_count: number;
  signoff_count: number;
  scenario_summary: string | null;
}

export async function listReports(db: D1Database, limit = 60): Promise<ReportSummary[]> {
  return (
    await db
      .prepare(
        `SELECT channel, payout_id, payout_date, net_cents, expected_cents, difference_cents, status, sale_count, review_count,
           gst_cents, provisional, blocking_count, signoff_count, scenario_summary
         FROM payout_reports ORDER BY payout_date DESC, channel LIMIT ?`,
      )
      .bind(limit)
      .all<ReportSummary>()
  ).results;
}

export async function getReport(db: D1Database, channel: string, payoutId: string): Promise<PayoutReport | null> {
  const row = await db
    .prepare("SELECT report_json FROM payout_reports WHERE channel = ? AND payout_id = ?")
    .bind(channel, payoutId)
    .first<{ report_json: string }>();
  return row ? (JSON.parse(row.report_json) as PayoutReport) : null;
}

export async function reportExists(db: D1Database, channel: string, payoutId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM payout_reports WHERE channel = ? AND payout_id = ?")
    .bind(channel, payoutId)
    .first<{ x: number }>();
  return !!row;
}

// ------------------------------------------------------------- stock intake

export interface StockInput {
  sku: string;
  title?: string;
  ownership: Ownership;
  acquired_from?: AcquiredFrom;
  item_condition?: Condition;
  purchase_cents?: number;
  purchase_date?: string;
  seller_name?: string;
  seller_address?: string;
  seller_description?: string;
  consignor_id?: number;
  commission_type?: "percent" | "fixed";
  commission_value?: number;
  override_scenario?: ScenarioCode;
  notes?: string;
}

const STOCK_FIELDS = [
  "title",
  "ownership",
  "acquired_from",
  "item_condition",
  "purchase_cents",
  "purchase_date",
  "seller_name",
  "seller_address",
  "seller_description",
  "consignor_id",
  "commission_type",
  "commission_value",
  "override_scenario",
  "notes",
] as const;

export const ACQUIRED_FROM_VALUES: AcquiredFrom[] = ["registered_supplier", "private_seller", "trade_in", "other"];
export const CONDITION_VALUES: Condition[] = ["new", "secondhand"];

export function validateStock(x: Partial<StockInput>): string[] {
  const errs: string[] = [];
  if (!x.sku?.trim()) errs.push("sku is required");
  if (x.ownership !== "owned" && x.ownership !== "consignment") errs.push("ownership must be 'owned' or 'consignment'");
  if (x.acquired_from && !ACQUIRED_FROM_VALUES.includes(x.acquired_from))
    errs.push(`acquired_from must be one of ${ACQUIRED_FROM_VALUES.join(", ")}`);
  if (x.item_condition && !CONDITION_VALUES.includes(x.item_condition)) errs.push("item_condition must be new or secondhand");
  if (x.ownership === "consignment" && !x.consignor_id) errs.push("consignment items need a consignor_id");
  if (x.commission_type && !["percent", "fixed"].includes(x.commission_type)) errs.push("commission_type must be percent or fixed");
  if (x.purchase_cents !== undefined && (!Number.isInteger(x.purchase_cents) || x.purchase_cents < 0))
    errs.push("purchase_cents must be a whole number of cents");
  return errs;
}

export async function upsertStock(db: D1Database, x: StockInput): Promise<void> {
  const cols = ["sku", ...STOCK_FIELDS];
  const vals = [x.sku.trim(), ...STOCK_FIELDS.map((f) => x[f] ?? null)];
  await db
    .prepare(
      `INSERT INTO stock_items (${cols.join(", ")}, updated_at) VALUES (${cols.map(() => "?").join(", ")}, datetime('now'))
       ON CONFLICT (sku) DO UPDATE SET ${STOCK_FIELDS.map((f) => `${f} = excluded.${f}`).join(", ")}, updated_at = datetime('now')`,
    )
    .bind(...vals)
    .run();
}

/** The facts staff can set one at a time from the review queue. */
export const FACT_FIELDS = {
  ownership: ["owned", "consignment"],
  acquired_from: ACQUIRED_FROM_VALUES,
  item_condition: CONDITION_VALUES,
} as const;
export type FactField = keyof typeof FACT_FIELDS;

/**
 * Record one fact against a SKU without touching its other fields. If the SKU
 * has no record of its own yet, one is created, starting from the SKU prefix
 * default (if any) so no prefix fact is lost.
 */
export async function setStockFact(db: D1Database, sku: string, field: FactField, value: string, title?: string): Promise<void> {
  const allowed = Object.hasOwn(FACT_FIELDS, field) ? (FACT_FIELDS[field] as readonly string[]) : null;
  if (!allowed || !allowed.includes(value)) throw new Error(`${field} can't be "${value}"`);
  const s = sku.trim();
  const existing = await db.prepare("SELECT sku FROM stock_items WHERE upper(sku) = upper(?)").bind(s).first<{ sku: string }>();
  if (!existing) {
    const prefixes = (await db.prepare("SELECT * FROM sku_prefix_rules").all<PrefixRow>()).results.sort((a, b) => b.prefix.length - a.prefix.length);
    const p = prefixes.find((x) => s.toUpperCase().startsWith(x.prefix.toUpperCase()));
    const ownership = field === "ownership" ? value : p?.ownership;
    if (!ownership) throw new Error(`Record whether ${s} is LOFI-owned or consignment first`);
    await db
      .prepare(
        `INSERT INTO stock_items (sku, title, ownership, acquired_from, item_condition, consignor_id, commission_type, commission_value, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        s,
        title ?? null,
        ownership,
        p?.acquired_from ?? null,
        p?.item_condition ?? null,
        p?.consignor_id ?? null,
        p?.commission_type ?? null,
        p?.commission_value ?? null,
        p ? `Created from SKU prefix ${p.prefix} via review queue` : "Created via review queue",
      )
      .run();
  }
  await db
    .prepare(`UPDATE stock_items SET ${field} = ?, updated_at = datetime('now') WHERE upper(sku) = upper(?)`)
    .bind(value, s)
    .run();
}

export async function setConsignorGst(db: D1Database, id: number, registered: boolean): Promise<void> {
  await db
    .prepare("UPDATE consignors SET gst_status = ?, gst_registered = ? WHERE id = ?")
    .bind(registered ? "registered" : "not_registered", registered ? 1 : 0, id)
    .run();
}

export async function addConsignor(
  db: D1Database,
  c: {
    name: string;
    contact?: string;
    gst_registered: boolean | null;
    abn?: string;
    commission_type?: string;
    commission_value?: number;
    agreement_type?: string;
  },
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO consignors (name, contact, gst_registered, gst_status, abn, commission_type, commission_value, agreement_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      c.name,
      c.contact ?? null,
      c.gst_registered ? 1 : 0,
      c.gst_registered === null ? null : c.gst_registered ? "registered" : "not_registered",
      c.abn ?? null,
      c.commission_type ?? "percent",
      c.commission_value ?? 0,
      c.agreement_type ?? "agency",
    )
    .first<{ id: number }>();
  return r!.id;
}
