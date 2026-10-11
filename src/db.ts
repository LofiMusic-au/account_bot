// D1 access: stock/consignor facts, source provenance, and payout reports.

import { saleScenarioCounts, type PayoutReport } from "./reconcile";
import { skuOwnershipRule } from "./rules/sku-ownership";
import {
  costKey,
  validateRule,
  type BasTreatment,
  type ConsignmentEntry,
  type ManualCosts,
  type PartyRole,
  type SettlementRule,
} from "./accounting/consignment";
import type { StockResolver } from "./rules/engine";
import type {
  AcquiredFrom,
  Channel,
  Condition,
  Consignor,
  Issue,
  NormalisedPayout,
  Ownership,
  SaleLine,
  ScenarioCode,
  StockItem,
} from "./types";

export interface ConsignorRow {
  id: number;
  name: string;
  country: string | null;
  australian_gst_registered: number | null;
  australian_gst_basis: "recorded" | "intake_default_overseas" | null;
  commission_type: "percent" | "fixed";
  commission_value: number;
  agreement_type: "agency" | "153B" | null;
  settlement_rule_id?: number | null;
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
  settlement_rule_id?: number | null;
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
  country: r.country,
  australianGstRegistered: r.australian_gst_registered === null ? null : r.australian_gst_registered === 1,
  australianGstBasis: r.australian_gst_basis,
  commissionType: r.commission_type,
  commissionValue: r.commission_value,
  agreementType: r.agreement_type === "agency" || r.agreement_type === "153B" ? r.agreement_type : null,
  settlementRuleId: r.settlement_rule_id ?? null,
});

/** Ownership from LOFI's built-in SKU conventions (src/rules/sku-ownership.ts), or undefined. */
export const conventionOwnership = (sku: string): Ownership | undefined => skuOwnershipRule(sku)?.ownership;

/**
 * Pure resolver over preloaded rows. Precedence: the item's own record, then
 * the longest staff-created prefix rule, then LOFI's built-in SKU ownership
 * conventions (ownership only), else null (review). Listing links are applied
 * before this, so a linked listing resolves through the same order.
 */
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
        settlementRuleId: row.settlement_rule_id ?? null,
        source: "item",
        div66RecordComplete: isDiv66
          ? !!(row.seller_name && row.seller_address && row.seller_description && row.purchase_date && row.purchase_cents)
          : undefined,
      } satisfies StockItem;
    }
    const p = sortedPrefixes.find((x) => sku.trim().toUpperCase().startsWith(x.prefix.toUpperCase()));
    if (!p) {
      const rule = skuOwnershipRule(sku);
      if (!rule) return null;
      // Ownership only: no source, condition, price or consignor.
      return { sku, ownership: rule.ownership, acquiredFrom: null, condition: null, purchaseCents: null, consignor: null, source: "convention", prefix: rule.prefix, ruleId: rule.id } satisfies StockItem;
    }
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

/** Apply destinations recorded (or referred) by staff to orders the platform sent without one. */
export function applyOrderFacts(payout: NormalisedPayout, facts: Map<string, { destination_country: string | null; referred?: number }>): NormalisedPayout {
  const fix = <T extends { orderId: string; destinationCountry: string | null; shippingProgram: string }>(o: T): T => {
    const f = facts.get(o.orderId);
    if (!f || o.destinationCountry !== null) return o;
    if (!f.destination_country) return f.referred ? { ...o, destinationReferred: true } : o;
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
  const rows = await inChunks<{ order_id: string; destination_country: string | null; referred: number }>(
    db,
    (q) => `SELECT order_id, destination_country, referred FROM order_facts WHERE channel = ? AND order_id IN (${q})`,
    ids,
    [payout.channel],
  );
  return new Map(rows.map((r) => [r.order_id, r]));
}

/** Staff can't say where an order went: refer it for manual review instead of guessing. */
export async function referOrderDestination(db: D1Database, channel: Channel, orderId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO order_facts (channel, order_id, destination_country, referred, updated_at) VALUES (?, ?, NULL, 1, datetime('now'))
       ON CONFLICT (channel, order_id) DO UPDATE SET destination_country = NULL, referred = 1, updated_at = excluded.updated_at`,
    )
    .bind(channel, orderId)
    .run();
}

export async function setOrderDestination(db: D1Database, channel: Channel, orderId: string, country: string): Promise<void> {
  const c = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) throw new Error("Destination must be a two-letter country code, e.g. AU or NZ");
  await db
    .prepare(
      `INSERT INTO order_facts (channel, order_id, destination_country, referred, updated_at) VALUES (?, ?, ?, 0, datetime('now'))
       ON CONFLICT (channel, order_id) DO UPDATE SET destination_country = excluded.destination_country, referred = 0, updated_at = excluded.updated_at`,
    )
    .bind(channel, orderId, c)
    .run();
}

// ------------------------------------------------------------- listing map

/** Lines whose listing had no SKU, re-keyed to the stock SKU staff linked them to. */
export function applyListingMap(payout: NormalisedPayout, map: Map<string, string>): NormalisedPayout {
  if (map.size === 0) return payout;
  const fixOrder = <T extends { lines: SaleLine[] }>(o: T): T => ({
    ...o,
    lines: o.lines.map((l) => {
      const sku = l.skuFromListing && l.sku ? map.get(l.sku) : undefined;
      return sku ? { ...l, sku, skuFromListing: false, listingKey: l.sku! } : l;
    }),
  });
  return {
    ...payout,
    sales: payout.sales.map(fixOrder),
    refunds: payout.refunds.map((r) => (r.order ? { ...r, order: fixOrder(r.order) } : r)),
  };
}

export async function loadListingMap(db: D1Database, payout: NormalisedPayout): Promise<Map<string, string>> {
  const keys = [...payout.sales, ...payout.refunds.flatMap((r) => (r.order ? [r.order] : []))]
    .flatMap((o) => o.lines)
    .filter((l) => l.skuFromListing && l.sku)
    .map((l) => l.sku!);
  if (!keys.length) return new Map();
  const rows = await inChunks<{ listing_key: string; sku: string }>(
    db,
    (q) => `SELECT listing_key, sku FROM listing_sku_map WHERE channel = ? AND listing_key IN (${q})`,
    [...new Set(keys)],
    [payout.channel],
  );
  return new Map(rows.map((r) => [r.listing_key, r.sku]));
}

/** Link a SKU-less listing to a real stock SKU. Persists across re-imports. */
export async function linkListing(db: D1Database, channel: Channel, listingKey: string, sku: string): Promise<void> {
  const s = sku.trim();
  if (!s) throw new Error("Enter the stock SKU this listing is");
  if (s.toUpperCase() === listingKey.toUpperCase()) throw new Error("That's the listing itself; enter the stock SKU");
  await db
    .prepare(
      `INSERT INTO listing_sku_map (channel, listing_key, sku, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (channel, listing_key) DO UPDATE SET sku = excluded.sku, updated_at = excluded.updated_at`,
    )
    .bind(channel, listingKey, s)
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

// ------------------------------------------------- consignment ledger (SHADOW)

interface RuleRow {
  id: number;
  name: string;
  deduct_postage: number;
  deduct_fees: number;
  deduct_repairs: number;
  deduct_other: number;
  include_shipping_charged: number;
  bas_treatment: BasTreatment;
}
interface PartyRow {
  rule_id: number;
  position: number;
  role: PartyRole;
  name: string;
  share_bp: number | null;
  fixed_cents: number | null;
}

export async function loadRules(db: D1Database): Promise<Map<number, SettlementRule>> {
  const rules = (await db.prepare("SELECT * FROM settlement_rules ORDER BY name").all<RuleRow>()).results;
  const parties = (await db.prepare("SELECT * FROM settlement_rule_parties ORDER BY rule_id, position").all<PartyRow>()).results;
  return new Map(
    rules.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name,
        deductPostage: r.deduct_postage === 1,
        deductFees: r.deduct_fees === 1,
        deductRepairs: r.deduct_repairs === 1,
        deductOther: r.deduct_other === 1,
        includeShippingCharged: r.include_shipping_charged === 1,
        basTreatment: r.bas_treatment,
        parties: parties.filter((p) => p.rule_id === r.id).map((p) => ({ role: p.role, name: p.name, shareBp: p.share_bp, fixedCents: p.fixed_cents })),
      },
    ]),
  );
}

/** Create a settlement rule; optionally make it a consignor's default. */
export async function createRule(db: D1Database, r: Omit<SettlementRule, "id">, defaultForConsignorId?: number): Promise<number> {
  const errs = validateRule(r);
  if (!["unconfirmed", "gst_on_lofi_share", "none"].includes(r.basTreatment)) errs.push("unknown BAS treatment");
  if (errs.length) throw new Error(errs.join("; "));
  const row = await db
    .prepare(
      `INSERT INTO settlement_rules (name, deduct_postage, deduct_fees, deduct_repairs, deduct_other, include_shipping_charged, bas_treatment)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(r.name.trim(), +r.deductPostage, +r.deductFees, +r.deductRepairs, +r.deductOther, +r.includeShippingCharged, r.basTreatment)
    .first<{ id: number }>();
  const id = row!.id;
  await db.batch([
    ...r.parties.map((p, i) =>
      db
        .prepare("INSERT INTO settlement_rule_parties (rule_id, position, role, name, share_bp, fixed_cents) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, i, p.role, p.name.trim(), p.shareBp ?? null, p.fixedCents ?? null),
    ),
    ...(defaultForConsignorId ? [db.prepare("UPDATE consignors SET settlement_rule_id = ? WHERE id = ?").bind(id, defaultForConsignorId)] : []),
  ]);
  return id;
}

export async function setConsignorRule(db: D1Database, consignorId: number, ruleId: number | null): Promise<void> {
  await db.prepare("UPDATE consignors SET settlement_rule_id = ? WHERE id = ?").bind(ruleId, consignorId).run();
}

export async function loadCosts(db: D1Database, channel: string, orderIds: string[]): Promise<Map<string, ManualCosts>> {
  const rows = await inChunks<{ order_id: string; line_item_id: string; postage_cents: number | null; repairs_cents: number | null; other_cents: number | null }>(
    db,
    (q) => `SELECT order_id, line_item_id, postage_cents, repairs_cents, other_cents FROM consignment_costs WHERE channel = ? AND order_id IN (${q})`,
    [...new Set(orderIds)],
    [channel],
  );
  return new Map(rows.map((r) => [costKey(channel, r.order_id, r.line_item_id), { postageCents: r.postage_cents, repairsCents: r.repairs_cents, otherCents: r.other_cents }]));
}

/** Record manually entered costs for one sold item. null clears a value (postage then falls back to the shipping label). */
export async function saveCosts(
  db: D1Database,
  channel: string,
  orderId: string,
  lineItemId: string,
  c: ManualCosts & { note?: string | null },
): Promise<void> {
  for (const [k, v] of Object.entries({ postage: c.postageCents, repairs: c.repairsCents, other: c.otherCents })) {
    if (v !== null && (!Number.isInteger(v) || v < 0)) throw new Error(`${k} isn't a valid amount`);
  }
  await db
    .prepare(
      `INSERT INTO consignment_costs (channel, order_id, line_item_id, postage_cents, repairs_cents, other_cents, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (channel, order_id, line_item_id) DO UPDATE SET postage_cents = excluded.postage_cents,
         repairs_cents = excluded.repairs_cents, other_cents = excluded.other_cents, note = excluded.note, updated_at = excluded.updated_at`,
    )
    .bind(channel, orderId, lineItemId, c.postageCents, c.repairsCents, c.otherCents, c.note ?? null)
    .run();
}

/**
 * Bring the shadow ledger in line with a payout's current entries. Idempotent
 * on entry_key; entries are always recalculated (there is no posted state in
 * shadow mode). Entries that no longer apply are removed. Source
 * transactions are never touched.
 */
export async function syncConsignmentLedger(db: D1Database, channel: string, payoutId: string, entries: ConsignmentEntry[], now = new Date()): Promise<void> {
  const ts = now.toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const e of entries) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO consignment_entries (entry_key, channel, payout_id, order_id, order_name, line_item_id, source_transaction_id, sku, title,
             consignor_id, settlement_rule_id, rule_snapshot_json, kind, sale_date, item_cents, shipping_charged_cents, gross_sale_cents,
             fees_cents, postage_cents, postage_source, repairs_cents, other_cents, distributable_net_cents, consignor_share_cents,
             lofi_share_cents, other_shares_cents, shares_json, lofi_share_gst_cents, bas_treatment, accounting_period, status, problem,
             first_recorded_at, last_calculated_at)
           VALUES (${Array(34).fill("?").join(", ")})
           ON CONFLICT (entry_key) DO UPDATE SET
             order_name = excluded.order_name, sku = excluded.sku, title = excluded.title, consignor_id = excluded.consignor_id,
             settlement_rule_id = excluded.settlement_rule_id, rule_snapshot_json = excluded.rule_snapshot_json,
             sale_date = excluded.sale_date, item_cents = excluded.item_cents, shipping_charged_cents = excluded.shipping_charged_cents,
             gross_sale_cents = excluded.gross_sale_cents, fees_cents = excluded.fees_cents, postage_cents = excluded.postage_cents,
             postage_source = excluded.postage_source, repairs_cents = excluded.repairs_cents, other_cents = excluded.other_cents,
             distributable_net_cents = excluded.distributable_net_cents, consignor_share_cents = excluded.consignor_share_cents,
             lofi_share_cents = excluded.lofi_share_cents, other_shares_cents = excluded.other_shares_cents, shares_json = excluded.shares_json,
             lofi_share_gst_cents = excluded.lofi_share_gst_cents, bas_treatment = excluded.bas_treatment,
             accounting_period = excluded.accounting_period, status = excluded.status, problem = excluded.problem,
             last_calculated_at = excluded.last_calculated_at`,
        )
        .bind(
          e.entryKey, e.channel, e.payoutId, e.orderId, e.orderName, e.lineItemId, e.sourceTransactionId, e.sku, e.title,
          e.consignorId, e.settlementRuleId, e.ruleSnapshot ? JSON.stringify(e.ruleSnapshot) : null, e.kind, e.saleDate, e.itemCents,
          e.shippingChargedCents, e.grossSaleCents, e.feesCents, e.postageCents, e.postageSource, e.repairsCents, e.otherCents,
          e.distributableNetCents, e.consignorShareCents, e.lofiShareCents, e.otherSharesCents, e.shares ? JSON.stringify(e.shares) : null,
          e.lofiShareGstCents, e.basTreatment, e.accountingPeriod, e.status, e.problem, ts, ts,
        ),
    );
  }
  const keep = entries.map((e) => e.entryKey);
  stmts.push(
    db
      .prepare(`DELETE FROM consignment_entries WHERE channel = ? AND payout_id = ? ${keep.length ? `AND entry_key NOT IN (${keep.map(() => "?").join(",")})` : ""}`)
      .bind(channel, payoutId, ...keep),
  );
  await db.batch(stmts);
}

export interface ConsignmentRow {
  entry_key: string;
  channel: string;
  payout_id: string;
  order_id: string;
  order_name: string | null;
  line_item_id: string;
  sku: string | null;
  title: string | null;
  consignor_id: number | null;
  consignor_name: string | null;
  rule_name: string | null;
  kind: "sale" | "refund";
  sale_date: string;
  item_cents: number;
  shipping_charged_cents: number;
  gross_sale_cents: number;
  fees_cents: number;
  postage_cents: number;
  postage_source: string;
  repairs_cents: number;
  other_cents: number;
  distributable_net_cents: number | null;
  consignor_share_cents: number | null;
  lofi_share_cents: number | null;
  other_shares_cents: number | null;
  shares_json: string | null;
  lofi_share_gst_cents: number | null;
  bas_treatment: string | null;
  accounting_period: string;
  status: string;
  problem: string | null;
}

export async function listConsignmentRows(db: D1Database, period?: string): Promise<ConsignmentRow[]> {
  return (
    await db
      .prepare(
        `SELECT e.*, c.name AS consignor_name, r.name AS rule_name FROM consignment_entries e
         LEFT JOIN consignors c ON c.id = e.consignor_id LEFT JOIN settlement_rules r ON r.id = e.settlement_rule_id
         ${period ? "WHERE e.accounting_period = ?" : ""} ORDER BY e.accounting_period DESC, c.name, e.sale_date`,
      )
      .bind(...(period ? [period] : []))
      .all<ConsignmentRow>()
  ).results;
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
  posting_status?: string | null;
}

export async function listReports(db: D1Database, limit = 60, channel?: Channel): Promise<ReportSummary[]> {
  return (
    await db
      .prepare(
        `SELECT r.channel, r.payout_id, r.payout_date, r.net_cents, r.expected_cents, r.difference_cents, r.status, r.sale_count, r.review_count,
           r.gst_cents, r.provisional, r.blocking_count, r.signoff_count, r.scenario_summary, q.status AS posting_status
         FROM payout_reports r LEFT JOIN qbo_postings q ON q.channel = r.channel AND q.payout_id = r.payout_id
         ${channel ? "WHERE r.channel = ?" : ""} ORDER BY r.payout_date DESC, r.channel LIMIT ?`,
      )
      .bind(...(channel ? [channel, limit] : [limit]))
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

/**
 * Delete every payout report, its stored source data and the shadow
 * consignment ledger entries, so payouts can be fetched fresh. Stock records,
 * SKU prefix rules, consignors, settlement rules, order facts and manually
 * entered consignment costs are kept. Returns how many payouts were removed.
 */
export async function clearPayouts(db: D1Database): Promise<number> {
  const n = (await db.prepare("SELECT count(*) AS n FROM payout_reports").first<{ n: number }>())?.n ?? 0;
  await db.batch([
    db.prepare("DELETE FROM consignment_entries"),
    // Unposted QuickBooks previews go; anything posted (and its history) is kept.
    db.prepare("DELETE FROM qbo_postings WHERE journal_id IS NULL AND transfer_id IS NULL"),
    db.prepare("DELETE FROM payout_reports"),
    db.prepare("DELETE FROM source_transactions"),
    db.prepare("DELETE FROM source_orders"),
    db.prepare("DELETE FROM source_payouts"),
  ]);
  return n;
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
    const ownership = field === "ownership" ? value : (p?.ownership ?? conventionOwnership(s));
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

/** Record a consignor's Australian GST registration (by a person). */
/** Facts staff can record for a SKU in one go from the review queue. Absent = leave unchanged. */
export interface StockFacts {
  ownership?: Ownership;
  acquired_from?: AcquiredFrom;
  item_condition?: Condition;
  purchase_cents?: number;
  consignor_id?: number;
  commission_value?: number;
}

export function validateFacts(f: StockFacts): string[] {
  const errs: string[] = [];
  if (f.ownership && f.ownership !== "owned" && f.ownership !== "consignment") errs.push("ownership must be LOFI or consignment");
  if (f.acquired_from && !ACQUIRED_FROM_VALUES.includes(f.acquired_from)) errs.push("unknown acquisition source");
  if (f.item_condition && !CONDITION_VALUES.includes(f.item_condition)) errs.push("condition must be new or second-hand");
  if (f.purchase_cents !== undefined && (!Number.isInteger(f.purchase_cents) || f.purchase_cents < 0)) errs.push("purchase price isn't a valid amount");
  if (f.consignor_id !== undefined && !Number.isInteger(f.consignor_id)) errs.push("unknown consignor");
  if (f.commission_value !== undefined && (!Number.isFinite(f.commission_value) || f.commission_value < 0 || f.commission_value > 100))
    errs.push("commission must be a percentage between 0 and 100");
  if (f.ownership === "owned" && f.consignor_id !== undefined) errs.push("a LOFI-owned item can't have a consignor");
  if (f.ownership === "consignment" && f.acquired_from !== undefined) errs.push("acquisition source only applies to LOFI-owned stock");
  return errs;
}

/**
 * Record several facts for one SKU. Fields left out are kept. A SKU with no
 * record of its own starts from its SKU prefix default (if any) so no prefix
 * fact is lost; ownership must be known one way or the other.
 */
export async function saveStockFacts(db: D1Database, sku: string, f: StockFacts, title?: string): Promise<void> {
  const errs = validateFacts(f);
  if (errs.length) throw new Error(errs.join("; "));
  const s = sku.trim();
  if (!s) throw new Error("SKU is required");
  const existing = await db.prepare("SELECT sku FROM stock_items WHERE upper(sku) = upper(?)").bind(s).first<{ sku: string }>();
  if (!existing) {
    const prefixes = (await db.prepare("SELECT * FROM sku_prefix_rules").all<PrefixRow>()).results.sort((a, b) => b.prefix.length - a.prefix.length);
    const p = prefixes.find((x) => s.toUpperCase().startsWith(x.prefix.toUpperCase()));
    const ownership = f.ownership ?? p?.ownership ?? conventionOwnership(s);
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
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (f.ownership) set("ownership", f.ownership);
  if (f.ownership === "consignment") set("acquired_from", null);
  if (f.ownership === "owned") set("consignor_id", null);
  if (f.acquired_from) set("acquired_from", f.acquired_from);
  if (f.item_condition) set("item_condition", f.item_condition);
  if (f.purchase_cents !== undefined) set("purchase_cents", f.purchase_cents);
  if (f.consignor_id !== undefined) set("consignor_id", f.consignor_id);
  if (f.commission_value !== undefined) {
    set("commission_type", "percent");
    set("commission_value", f.commission_value);
  }
  if (title && !existing) set("title", title);
  if (!sets.length) return;
  await db
    .prepare(`UPDATE stock_items SET ${sets.join(", ")}, updated_at = datetime('now') WHERE upper(sku) = upper(?)`)
    .bind(...vals, s)
    .run();
}

export interface PrefixRuleInput {
  prefix: string;
  ownership: Ownership;
  acquired_from?: AcquiredFrom;
  item_condition?: Condition;
  consignor_id?: number;
  description?: string;
}

/**
 * Create a SKU prefix default. Safety rules: at least 2 characters, it must be
 * a prefix of the SKU it was created from, and an existing rule for the same
 * prefix is only replaced when `replace` is set. Individual stock records
 * always win over prefix rules, and purchase prices are never set by prefix.
 */
export async function savePrefixRule(db: D1Database, r: PrefixRuleInput, fromSku: string, replace = false): Promise<"created" | "replaced"> {
  const prefix = r.prefix.trim();
  if (prefix.length < 2) throw new Error("A prefix must be at least 2 characters");
  if (!fromSku.trim().toUpperCase().startsWith(prefix.toUpperCase())) throw new Error(`"${prefix}" isn't the start of ${fromSku}`);
  const errs = validateFacts({ ownership: r.ownership, acquired_from: r.acquired_from, item_condition: r.item_condition, consignor_id: r.consignor_id });
  if (!r.ownership) errs.push("a prefix rule needs ownership");
  if (errs.length) throw new Error(errs.join("; "));
  const existing = await db.prepare("SELECT prefix FROM sku_prefix_rules WHERE upper(prefix) = upper(?)").bind(prefix).first<{ prefix: string }>();
  if (existing && !replace) throw new Error(`A rule for "${existing.prefix}" already exists; tick "replace" to overwrite it`);
  if (existing) await db.prepare("DELETE FROM sku_prefix_rules WHERE upper(prefix) = upper(?)").bind(prefix).run();
  await db
    .prepare(
      `INSERT INTO sku_prefix_rules (prefix, description, ownership, acquired_from, item_condition, consignor_id) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(prefix, r.description ?? `Created from ${fromSku} via review queue`, r.ownership, r.acquired_from ?? null, r.item_condition ?? null, r.consignor_id ?? null)
    .run();
  return existing ? "replaced" : "created";
}

/** Stock rows and prefix rules for prefilling the review queue. */
export async function loadFactsFor(db: D1Database, skus: string[]): Promise<{ items: Map<string, StockRow>; prefixes: PrefixRow[] }> {
  const rows = await inChunks<StockRow>(db, (q) => `SELECT * FROM stock_items WHERE upper(sku) IN (${q})`, [...new Set(skus.map((x) => x.trim().toUpperCase()))]);
  const prefixes = (await db.prepare("SELECT * FROM sku_prefix_rules").all<PrefixRow>()).results;
  return { items: new Map(rows.map((r) => [r.sku.toUpperCase(), r])), prefixes };
}

export async function setConsignorGst(db: D1Database, id: number, registered: boolean): Promise<void> {
  await db
    .prepare("UPDATE consignors SET australian_gst_registered = ?, australian_gst_basis = 'recorded' WHERE id = ?")
    .bind(registered ? 1 : 0, id)
    .run();
}

export async function setConsignorAgreement(db: D1Database, id: number, agreement: "agency" | "153B"): Promise<void> {
  if (agreement !== "agency" && agreement !== "153B") throw new Error("Agreement must be agency or 153B");
  await db.prepare("UPDATE consignors SET agreement_type = ? WHERE id = ?").bind(agreement, id).run();
}

export interface ConsignorInput {
  name: string;
  contact?: string | null;
  /** ISO-2. */
  country?: string | null;
  /**
   * true / false as recorded by a person, null = not sure yet, "auto" =
   * default to false for an overseas consignor and unknown otherwise.
   */
  australian_gst_registered?: boolean | null | "auto";
  abn?: string | null;
  commission_type?: "percent" | "fixed";
  commission_value?: number;
  agreement_type?: "agency" | "153B" | null;
  notes?: string | null;
}

export function validateConsignor(c: Partial<ConsignorInput>): string[] {
  const errs: string[] = [];
  if (!c.name?.trim()) errs.push("name is required");
  if (c.country && !/^[A-Za-z]{2}$/.test(c.country.trim())) errs.push("country must be a two-letter code, e.g. US or JP");
  if (c.australian_gst_registered !== undefined && ![true, false, null, "auto"].includes(c.australian_gst_registered as never))
    errs.push("australian_gst_registered must be true, false, null or \"auto\"");
  if (c.agreement_type !== undefined && c.agreement_type !== null && !["agency", "153B"].includes(c.agreement_type))
    errs.push("agreement_type must be agency, 153B or null (unknown)");
  if (c.commission_type && !["percent", "fixed"].includes(c.commission_type)) errs.push("commission_type must be percent or fixed");
  if (c.commission_value !== undefined && (!Number.isFinite(c.commission_value) || c.commission_value < 0))
    errs.push("commission_value must be a number of at least 0");
  return errs;
}

/**
 * Intake default for Australian GST registration. Most LOFI consignors are
 * overseas and not registered for Australian GST, so an overseas consignor
 * defaults to "no" (marked as an intake default, editable). An Australian or
 * unrecorded country stays unknown so a person is asked. Foreign VAT/GST
 * registration is never inferred.
 */
export function australianGstAtIntake(
  country: string | null | undefined,
  answer: boolean | null | "auto" | undefined,
): { registered: boolean | null; basis: ConsignorRow["australian_gst_basis"] } {
  if (answer === true || answer === false) return { registered: answer, basis: "recorded" };
  if (answer === null) return { registered: null, basis: null };
  const c = country?.trim().toUpperCase();
  if (c && c !== "AU") return { registered: false, basis: "intake_default_overseas" };
  return { registered: null, basis: null };
}

export async function addConsignor(db: D1Database, c: ConsignorInput): Promise<number> {
  const country = c.country?.trim().toUpperCase() || null;
  const gst = australianGstAtIntake(country, c.australian_gst_registered ?? "auto");
  const r = await db
    .prepare(
      `INSERT INTO consignors (name, contact, country, australian_gst_registered, australian_gst_basis, abn,
         commission_type, commission_value, agreement_type, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      c.name.trim(),
      c.contact ?? null,
      country,
      gst.registered === null ? null : gst.registered ? 1 : 0,
      gst.basis,
      c.abn ?? null,
      c.commission_type ?? "percent",
      c.commission_value ?? 0,
      c.agreement_type ?? null,
      c.notes ?? null,
    )
    .first<{ id: number }>();
  return r!.id;
}
