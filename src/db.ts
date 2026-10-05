// D1 access: stock/consignor lookups and payout report history.

import type { PayoutReport } from "./reconcile";
import type { StockResolver } from "./rules/engine";
import type { AcquiredFrom, Consignor, NormalisedPayout, Ownership, ScenarioCode, StockItem } from "./types";

interface ConsignorRow {
  id: number;
  name: string;
  gst_registered: number;
  commission_type: "percent" | "fixed";
  commission_value: number;
  agreement_type: "agency" | "153B";
}
interface StockRow {
  sku: string;
  title: string | null;
  ownership: Ownership;
  acquired_from: AcquiredFrom | null;
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
interface PrefixRow {
  prefix: string;
  ownership: Ownership;
  acquired_from: AcquiredFrom | null;
  consignor_id: number | null;
  commission_type: "percent" | "fixed" | null;
  commission_value: number | null;
}

const toConsignor = (r: ConsignorRow): Consignor => ({
  id: r.id,
  name: r.name,
  gstRegistered: r.gst_registered === 1,
  commissionType: r.commission_type,
  commissionValue: r.commission_value,
  agreementType: r.agreement_type,
});

/** Pure resolver over preloaded rows: an item's own record beats the longest matching prefix. */
export function makeResolver(items: StockRow[], prefixes: PrefixRow[], consignors: ConsignorRow[]): StockResolver {
  const bySku = new Map(items.map((i) => [i.sku.toUpperCase(), i]));
  const byId = new Map(consignors.map((c) => [c.id, toConsignor(c)]));
  const sortedPrefixes = [...prefixes].sort((a, b) => b.prefix.length - a.prefix.length);
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
        purchaseCents: row.purchase_cents,
        consignor: row.consignor_id ? (byId.get(row.consignor_id) ?? null) : null,
        commissionType: row.commission_type,
        commissionValue: row.commission_value,
        overrideScenario: row.override_scenario,
        source: "item",
        div66RecordComplete: isDiv66
          ? !!(row.seller_name && row.seller_address && row.seller_description && row.purchase_date && row.purchase_cents)
          : undefined,
      } satisfies StockItem;
    }
    const p = sortedPrefixes.find((x) => sku.toUpperCase().startsWith(x.prefix.toUpperCase()));
    if (!p) return null;
    return {
      sku,
      ownership: p.ownership,
      acquiredFrom: p.acquired_from,
      purchaseCents: null,
      consignor: p.consignor_id ? (byId.get(p.consignor_id) ?? null) : null,
      commissionType: p.commission_type,
      commissionValue: p.commission_value,
      source: "prefix",
    } satisfies StockItem;
  };
}

export async function loadResolver(db: D1Database, payout: NormalisedPayout): Promise<StockResolver> {
  const skus = new Set<string>();
  for (const o of [...payout.sales, ...payout.refunds.flatMap((r) => (r.order ? [r.order] : []))]) {
    for (const l of o.lines) if (l.sku) skus.add(l.sku.trim().toUpperCase());
  }
  const list = [...skus];
  const items: StockRow[] = [];
  // D1 caps bound parameters per statement; query in chunks.
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const r = await db
      .prepare(`SELECT * FROM stock_items WHERE upper(sku) IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<StockRow>();
    items.push(...r.results);
  }
  const prefixes = (await db.prepare("SELECT * FROM sku_prefix_rules").all<PrefixRow>()).results;
  const consignors = (await db.prepare("SELECT * FROM consignors").all<ConsignorRow>()).results;
  return makeResolver(items, prefixes, consignors);
}

export async function saveReport(db: D1Database, r: PayoutReport): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payout_reports (channel, payout_id, payout_date, net_cents, expected_cents, difference_cents,
         status, sale_count, review_count, gst_cents, report_json, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel, payout_id) DO UPDATE SET
         payout_date = excluded.payout_date, net_cents = excluded.net_cents, expected_cents = excluded.expected_cents,
         difference_cents = excluded.difference_cents, status = excluded.status, sale_count = excluded.sale_count,
         review_count = excluded.review_count, gst_cents = excluded.gst_cents, report_json = excluded.report_json,
         generated_at = excluded.generated_at`,
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
    )
    .run();
}

export interface ReportSummary {
  channel: string;
  payout_id: string;
  payout_date: string;
  net_cents: number;
  difference_cents: number;
  status: string;
  sale_count: number;
  review_count: number;
  gst_cents: number;
}

export async function listReports(db: D1Database, limit = 60): Promise<ReportSummary[]> {
  return (
    await db
      .prepare(
        `SELECT channel, payout_id, payout_date, net_cents, difference_cents, status, sale_count, review_count, gst_cents
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

export function validateStock(x: Partial<StockInput>): string[] {
  const errs: string[] = [];
  if (!x.sku?.trim()) errs.push("sku is required");
  if (x.ownership !== "owned" && x.ownership !== "consignment") errs.push("ownership must be 'owned' or 'consignment'");
  if (x.acquired_from && !["registered_supplier", "private_seller", "trade_in"].includes(x.acquired_from))
    errs.push("acquired_from must be registered_supplier, private_seller or trade_in");
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

export async function addConsignor(
  db: D1Database,
  c: { name: string; contact?: string; gst_registered: boolean; abn?: string; commission_type?: string; commission_value?: number; agreement_type?: string },
): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO consignors (name, contact, gst_registered, abn, commission_type, commission_value, agreement_type)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      c.name,
      c.contact ?? null,
      c.gst_registered ? 1 : 0,
      c.abn ?? null,
      c.commission_type ?? "percent",
      c.commission_value ?? 0,
      c.agreement_type ?? "agency",
    )
    .first<{ id: number }>();
  return r!.id;
}
