// SHADOW MODE. This module is a prototype that runs alongside Jess's manual
// consignment ledger, which remains the operational source of truth. Its
// figures are provisional and non-authoritative: they must not be used for
// real consignor payouts, QuickBooks journals or liability balances, and
// nothing here marks an entry as posted or paid. Its purpose is to show it
// can reproduce Jess's ledger before any cutover.
export const CONSIGNMENT_MODULE_MODE = "shadow" as const;

// Mirrors Jess's ledger:
//
//   Sale                      item price after discounts (+ shipping the buyer paid, per rule)
//   - actual postage          manual entry, else the platform shipping-label cost
//   - marketplace/payment fees  automatic, from the payout
//   - repairs                 manual entry
//   - other agreed costs      manual entry
//   = distributable NET
//
// NET is then shared between the parties of the item's settlement rule
// (e.g. 65/25/10, 65/25/5/5, 75/20/5, 50/50): fixed amounts first, the rest
// by percentage, always adding up to NET exactly. Each rule says which costs
// it deducts. GST/BAS on LOFI's share is NOT assumed: a rule's BAS treatment
// stays "unconfirmed" (no figure) until LOFI and the accountant confirm it.
//
// The same normalised sale feeds the payout reconciler and this ledger; a
// settlement rule or cost change recalculates entries and never touches the
// source sale.

import { allocate, gstInclusive } from "../money";
import { rescaleOrder, type StockResolver } from "../rules/engine";
import type { Fee, NormalisedPayout, OrderSale } from "../types";

// ------------------------------------------------------------------- rules

export type PartyRole = "consignor" | "lofi" | "partner";
export type BasTreatment = "unconfirmed" | "gst_on_lofi_share" | "none";

export interface SettlementParty {
  role: PartyRole;
  name: string;
  /** Basis points of the NET after fixed amounts (6500 = 65%). */
  shareBp?: number | null;
  /** A fixed amount taken from NET before the percentage shares. */
  fixedCents?: number | null;
}

export interface SettlementRule {
  id: number;
  name: string;
  deductPostage: boolean;
  deductFees: boolean;
  deductRepairs: boolean;
  deductOther: boolean;
  includeShippingCharged: boolean;
  basTreatment: BasTreatment;
  parties: SettlementParty[];
}

export function validateRule(r: Pick<SettlementRule, "name" | "parties">): string[] {
  const errs: string[] = [];
  if (!r.name?.trim()) errs.push("a rule needs a name");
  if (r.parties.length === 0) errs.push("a rule needs at least one party");
  if (r.parties.filter((p) => p.role === "consignor").length !== 1) errs.push("a rule needs exactly one consignor party");
  if (r.parties.filter((p) => p.role === "lofi").length !== 1) errs.push("a rule needs exactly one LOFI party");
  for (const p of r.parties) {
    if (!p.name?.trim()) errs.push("every party needs a name");
    const hasShare = p.shareBp !== null && p.shareBp !== undefined;
    const hasFixed = p.fixedCents !== null && p.fixedCents !== undefined;
    if (hasShare === hasFixed) errs.push(`${p.name || "a party"} needs either a percentage or a fixed amount`);
    if (hasShare && (!Number.isInteger(p.shareBp) || p.shareBp! < 0)) errs.push(`${p.name}: percentage isn't valid`);
    if (hasFixed && (!Number.isInteger(p.fixedCents) || p.fixedCents! < 0)) errs.push(`${p.name}: fixed amount isn't valid`);
  }
  const pct = r.parties.filter((p) => p.shareBp !== null && p.shareBp !== undefined);
  if (pct.length && pct.reduce((a, p) => a + (p.shareBp ?? 0), 0) !== 10_000) errs.push("percentage shares must add up to 100%");
  if (!pct.length) errs.push("at least one party needs a percentage share (it takes what's left after fixed amounts)");
  return errs;
}

// -------------------------------------------------------------- calculation

export interface SettlementInput {
  grossSaleCents: number;
  feesCents: number;
  postageCents: number;
  repairsCents: number;
  otherCents: number;
}

export interface PartyShare {
  role: PartyRole;
  name: string;
  cents: number;
}

export interface SettlementResult {
  distributableNetCents: number;
  shares: PartyShare[];
  consignorShareCents: number;
  lofiShareCents: number;
  otherSharesCents: number;
  /** null while the rule's BAS treatment is unconfirmed. */
  lofiShareGstCents: number | null;
}

/**
 * Deterministic settlement. Integer cents only; the shares always add up to
 * NET. A refund (negative sale) reverses: fixed amounts are reversed too.
 */
export function settle(input: SettlementInput, rule: SettlementRule): SettlementResult {
  const net =
    input.grossSaleCents -
    (rule.deductFees ? input.feesCents : 0) -
    (rule.deductPostage ? input.postageCents : 0) -
    (rule.deductRepairs ? input.repairsCents : 0) -
    (rule.deductOther ? input.otherCents : 0);
  const sign = input.grossSaleCents < 0 ? -1 : 1;
  const fixed = rule.parties.map((p) => (p.fixedCents ?? null) === null ? 0 : sign * p.fixedCents!);
  const remainder = net - fixed.reduce((a, b) => a + b, 0);
  const pctIdx = rule.parties.map((p, i) => ((p.shareBp ?? null) === null ? -1 : i)).filter((i) => i >= 0);
  const pctParts = allocate(remainder, pctIdx.map((i) => rule.parties[i]!.shareBp!));
  const cents = rule.parties.map((_, i) => fixed[i]! + (pctIdx.includes(i) ? pctParts[pctIdx.indexOf(i)]! : 0));
  const shares = rule.parties.map((p, i) => ({ role: p.role, name: p.name, cents: cents[i]! }));
  const of = (role: PartyRole) => shares.filter((s) => s.role === role).reduce((a, s) => a + s.cents, 0);
  const lofi = of("lofi");
  return {
    distributableNetCents: net,
    shares,
    consignorShareCents: of("consignor"),
    lofiShareCents: lofi,
    otherSharesCents: of("partner"),
    lofiShareGstCents: rule.basTreatment === "gst_on_lofi_share" ? gstInclusive(lofi) : rule.basTreatment === "none" ? 0 : null,
  };
}

// ------------------------------------------------------------------ entries

export interface ManualCosts {
  postageCents: number | null;
  repairsCents: number | null;
  otherCents: number | null;
}

export interface ConsignmentEntry {
  entryKey: string;
  channel: string;
  payoutId: string;
  orderId: string;
  orderName: string;
  lineItemId: string;
  sourceTransactionId: string | null;
  sku: string | null;
  title: string;
  consignorId: number | null;
  consignorName: string | null;
  settlementRuleId: number | null;
  ruleSnapshot: SettlementRule | null;
  kind: "sale" | "refund";
  saleDate: string;
  itemCents: number;
  shippingChargedCents: number;
  grossSaleCents: number;
  feesCents: number;
  postageCents: number;
  postageSource: "manual" | "shipping_label" | "none";
  repairsCents: number;
  otherCents: number;
  distributableNetCents: number | null;
  consignorShareCents: number | null;
  lofiShareCents: number | null;
  otherSharesCents: number | null;
  shares: PartyShare[] | null;
  lofiShareGstCents: number | null;
  basTreatment: BasTreatment | null;
  accountingPeriod: string;
  status: "calculated" | "incomplete";
  problem: string | null;
}

export interface LedgerContext {
  rules: Map<number, SettlementRule>;
  /** Keyed `${channel}|${orderId}|${lineItemId}`. */
  costs: Map<string, ManualCosts>;
}

export const costKey = (channel: string, orderId: string, lineItemId: string) => `${channel}|${orderId}|${lineItemId}`;

/**
 * Fees and shipping labels paid by the transaction that collected (or
 * refunded) this order, shared across the order's lines by amount.
 */
function orderCosts(payout: NormalisedPayout, order: OrderSale, sourceTransactionId: string | null) {
  const mine = (f: Fee) => f.orderId === order.orderId && (sourceTransactionId === null || f.source.transactionId === sourceTransactionId || f.category === "shipping_label");
  const fees = payout.fees.filter((f) => mine(f) && f.category !== "shipping_label").reduce((a, f) => a + f.cents, 0);
  const labels = payout.fees.filter((f) => f.orderId === order.orderId && f.category === "shipping_label").reduce((a, f) => a + f.cents, 0);
  const weights = order.lines.map((l) => Math.abs(l.grossCents) + 0);
  return { fees: allocate(fees, weights), labels: allocate(labels, weights) };
}

function entriesForOrder(
  payout: NormalisedPayout,
  order: OrderSale,
  kind: "sale" | "refund",
  sourceTransactionId: string | null,
  date: string,
  resolve: StockResolver,
  ctx: LedgerContext,
): ConsignmentEntry[] {
  const ship = allocate(order.shippingCents, order.lines.map((l) => Math.abs(l.grossCents)));
  const costs = orderCosts(payout, order, sourceTransactionId);
  const out: ConsignmentEntry[] = [];
  order.lines.forEach((line, i) => {
    if (line.placeholder) return;
    const item = resolve(line.sku);
    if (!item || item.ownership !== "consignment") return;
    const ruleId = item.settlementRuleId ?? item.consignor?.settlementRuleId ?? null;
    const rule = ruleId !== null ? (ctx.rules.get(ruleId) ?? null) : null;
    const manual = kind === "sale" ? ctx.costs.get(costKey(payout.channel, order.orderId, line.lineId)) : undefined;
    const labelCost = kind === "sale" ? (costs.labels[i] ?? 0) : 0;
    const postage = manual?.postageCents ?? labelCost;
    const postageSource: ConsignmentEntry["postageSource"] =
      manual?.postageCents !== null && manual?.postageCents !== undefined ? "manual" : labelCost ? "shipping_label" : "none";
    const shippingCharged = ship[i] ?? 0;
    const includeShipping = rule?.includeShippingCharged ?? true;
    const input: SettlementInput = {
      grossSaleCents: line.grossCents + (includeShipping ? shippingCharged : 0),
      feesCents: costs.fees[i] ?? 0,
      postageCents: postage,
      repairsCents: manual?.repairsCents ?? 0,
      otherCents: manual?.otherCents ?? 0,
    };
    const problem = !item.consignor
      ? "No consignor recorded"
      : ruleId === null
        ? "No settlement rule for this consignor or item"
        : !rule
          ? `Settlement rule #${ruleId} not found`
          : null;
    const result = rule && !problem ? settle(input, rule) : null;
    out.push({
      entryKey: [payout.channel, sourceTransactionId ?? order.orderId, line.lineId, kind].join("|"),
      channel: payout.channel,
      payoutId: payout.payoutId,
      orderId: order.orderId,
      orderName: order.orderName,
      lineItemId: line.lineId,
      sourceTransactionId,
      sku: line.sku,
      title: line.title,
      consignorId: item.consignor?.id ?? null,
      consignorName: item.consignor?.name ?? null,
      settlementRuleId: ruleId,
      ruleSnapshot: rule,
      kind,
      saleDate: date.slice(0, 10),
      itemCents: line.grossCents,
      shippingChargedCents: shippingCharged,
      grossSaleCents: input.grossSaleCents,
      feesCents: input.feesCents,
      postageCents: input.postageCents,
      postageSource,
      repairsCents: input.repairsCents,
      otherCents: input.otherCents,
      distributableNetCents: result?.distributableNetCents ?? null,
      consignorShareCents: result?.consignorShareCents ?? null,
      lofiShareCents: result?.lofiShareCents ?? null,
      otherSharesCents: result?.otherSharesCents ?? null,
      shares: result?.shares ?? null,
      lofiShareGstCents: result?.lofiShareGstCents ?? null,
      basTreatment: rule?.basTreatment ?? null,
      accountingPeriod: payout.payoutDate.slice(0, 7),
      status: result ? "calculated" : "incomplete",
      problem,
    });
  });
  return out;
}

/** Every consigned item line in a payout (sales and refunds) as shadow ledger entries. */
export function consignmentEntries(payout: NormalisedPayout, resolve: StockResolver, ctx: LedgerContext = { rules: new Map(), costs: new Map() }): ConsignmentEntry[] {
  const out: ConsignmentEntry[] = [];
  for (const o of payout.sales) out.push(...entriesForOrder(payout, o, "sale", o.sources[0]?.transactionId ?? null, o.orderDate, resolve, ctx));
  for (const r of payout.refunds) {
    if (!r.order) continue; // the refund_unmatched issue already blocks the payout
    out.push(...entriesForOrder(payout, rescaleOrder(r.order, -r.cents), "refund", r.source.transactionId, r.date, resolve, ctx));
  }
  return out;
}

// ------------------------------------------------------------------- totals

export interface PeriodTotals {
  period: string;
  consignorId: number | null;
  consignorName: string | null;
  entries: number;
  incomplete: number;
  grossSaleCents: number;
  feesCents: number;
  postageCents: number;
  repairsCents: number;
  otherCents: number;
  netCents: number;
  consignorShareCents: number;
  lofiShareCents: number;
  otherSharesCents: number;
}

type TotalsInput = Pick<
  ConsignmentEntry,
  | "accountingPeriod"
  | "consignorId"
  | "consignorName"
  | "status"
  | "grossSaleCents"
  | "feesCents"
  | "postageCents"
  | "repairsCents"
  | "otherCents"
  | "distributableNetCents"
  | "consignorShareCents"
  | "lofiShareCents"
  | "otherSharesCents"
>;

/** Draft monthly settlement per consignor. Incomplete entries are counted, not summed. */
export function periodTotals(entries: TotalsInput[]): PeriodTotals[] {
  const map = new Map<string, PeriodTotals>();
  for (const e of entries) {
    const key = `${e.accountingPeriod}|${e.consignorId ?? ""}`;
    const t = map.get(key) ?? {
      period: e.accountingPeriod,
      consignorId: e.consignorId,
      consignorName: e.consignorName,
      entries: 0,
      incomplete: 0,
      grossSaleCents: 0,
      feesCents: 0,
      postageCents: 0,
      repairsCents: 0,
      otherCents: 0,
      netCents: 0,
      consignorShareCents: 0,
      lofiShareCents: 0,
      otherSharesCents: 0,
    };
    t.entries++;
    if (e.status !== "calculated") t.incomplete++;
    else {
      t.grossSaleCents += e.grossSaleCents;
      t.feesCents += e.feesCents;
      t.postageCents += e.postageCents;
      t.repairsCents += e.repairsCents;
      t.otherCents += e.otherCents;
      t.netCents += e.distributableNetCents ?? 0;
      t.consignorShareCents += e.consignorShareCents ?? 0;
      t.lofiShareCents += e.lofiShareCents ?? 0;
      t.otherSharesCents += e.otherSharesCents ?? 0;
    }
    map.set(key, t);
  }
  return [...map.values()].sort((a, b) => b.period.localeCompare(a.period) || (a.consignorName ?? "").localeCompare(b.consignorName ?? ""));
}
