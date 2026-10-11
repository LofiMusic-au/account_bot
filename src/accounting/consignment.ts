// SHADOW MODE. This module is a prototype that runs alongside Jess's manual
// consignment ledger, which remains the operational source of truth. Its
// figures are provisional and non-authoritative: they must not be used for
// real consignor payouts, QuickBooks journals or liability balances, and
// nothing here marks an entry as posted or paid. Its purpose is to show it
// can reproduce Jess's ledger before any cutover.
export const CONSIGNMENT_MODULE_MODE = "shadow" as const;

// Stage 2 of LOFI's historical method: the consignment subledger that used to
// be a hand-kept spreadsheet. The same marketplace sale that the payout split
// records as CONSIGNMENT_SALES_NO_GST appears here, with the consignor's rule
// applied:
//
//   commission       = rule applied to the commission basis
//   commission GST   = 1/11 of the commission (LOFI's own taxable supply)
//   consignor payable = basis - commission
//
// The commission GST is kept here, separate from the marketplace sale's GST.
// Entries are aggregated by accounting period into the totals LOFI used to
// journal by hand. Nothing is posted.
//
// Working assumptions (historical baseline, to confirm with LOFI/accountant):
//   * Commission basis = the item's sale price after discounts, GST-inclusive,
//     excluding shipping (shipping share is recorded for information).
//   * Accounting period = calendar month of the payout date.
//   * The same commission GST method applies to every consignor; the B1/B2/
//     153-B draft scenarios remain the route to any change.

import { allocate, gstInclusive } from "../money";
import { commissionFor, rescaleOrder, type StockResolver } from "../rules/engine";
import type { NormalisedPayout, OrderSale, StockItem } from "../types";

export const COMMISSION_BASIS = "item_after_discounts_excl_shipping" as const;

export interface CommissionRule {
  type: "percent" | "fixed";
  /** Percent (25 = 25%) or fixed AUD per unit. */
  value: number;
}

export interface CommissionResult {
  commissionCents: number;
  commissionGstCents: number;
  consignorPayableCents: number;
}

/** Deterministic commission calculation on a GST-inclusive basis (negative for refunds). */
export function calculateCommission(basisCents: number, quantity: number, rule: CommissionRule): CommissionResult {
  const item: StockItem = { sku: "", ownership: "consignment", source: "item", commissionType: rule.type, commissionValue: rule.value };
  const commission = commissionFor(item, basisCents, quantity)!;
  return {
    commissionCents: commission,
    commissionGstCents: gstInclusive(commission),
    consignorPayableCents: basisCents - commission,
  };
}

export interface ConsignmentEntry {
  /** Stable key: re-importing the payout updates the same entry. */
  entryKey: string;
  channel: string;
  payoutId: string;
  orderId: string;
  orderName: string;
  lineItemId: string;
  sourceTransactionId: string | null;
  sku: string | null;
  consignorId: number | null;
  consignorName: string | null;
  kind: "sale" | "refund";
  saleDate: string;
  grossSaleCents: number;
  shippingCents: number;
  discountCents: number;
  commissionBasis: typeof COMMISSION_BASIS;
  commissionType: "percent" | "fixed" | null;
  commissionValue: number | null;
  commissionCents: number | null;
  commissionGstCents: number | null;
  consignorPayableCents: number | null;
  accountingPeriod: string;
  status: "calculated" | "incomplete";
  problem: string | null;
}

function entriesForOrder(
  payout: NormalisedPayout,
  order: OrderSale,
  kind: "sale" | "refund",
  sourceTransactionId: string | null,
  date: string,
  resolve: StockResolver,
): ConsignmentEntry[] {
  const shipShares = allocate(order.shippingCents, order.lines.map((l) => Math.abs(l.grossCents)));
  const out: ConsignmentEntry[] = [];
  order.lines.forEach((line, i) => {
    if (line.placeholder) return;
    const item = resolve(line.sku);
    if (!item || item.ownership !== "consignment") return;
    const type = item.commissionType ?? item.consignor?.commissionType ?? null;
    const value = item.commissionValue ?? item.consignor?.commissionValue ?? null;
    const problem = !item.consignor
      ? "No consignor recorded"
      : type === null || value === null
        ? "No commission rule"
        : null;
    const calc = problem ? null : calculateCommission(line.grossCents, line.quantity, { type: type!, value: value! });
    out.push({
      entryKey: [payout.channel, sourceTransactionId ?? order.orderId, line.lineId, kind].join("|"),
      channel: payout.channel,
      payoutId: payout.payoutId,
      orderId: order.orderId,
      orderName: order.orderName,
      lineItemId: line.lineId,
      sourceTransactionId,
      sku: line.sku,
      consignorId: item.consignor?.id ?? null,
      consignorName: item.consignor?.name ?? null,
      kind,
      saleDate: date.slice(0, 10),
      grossSaleCents: line.grossCents,
      shippingCents: shipShares[i] ?? 0,
      discountCents: kind === "sale" ? line.discountCents : 0,
      commissionBasis: COMMISSION_BASIS,
      commissionType: type,
      commissionValue: value,
      commissionCents: calc?.commissionCents ?? null,
      commissionGstCents: calc?.commissionGstCents ?? null,
      consignorPayableCents: calc?.consignorPayableCents ?? null,
      accountingPeriod: payout.payoutDate.slice(0, 7),
      status: problem ? "incomplete" : "calculated",
      problem,
    });
  });
  return out;
}

/** Every consignment line in a payout (sales and refunds) as subledger entries. */
export function consignmentEntries(payout: NormalisedPayout, resolve: StockResolver): ConsignmentEntry[] {
  const out: ConsignmentEntry[] = [];
  for (const o of payout.sales) out.push(...entriesForOrder(payout, o, "sale", o.sources[0]?.transactionId ?? null, o.orderDate, resolve));
  for (const r of payout.refunds) {
    if (!r.order) continue; // the refund_unmatched issue already blocks the payout
    out.push(...entriesForOrder(payout, rescaleOrder(r.order, -r.cents), "refund", r.source.transactionId, r.date, resolve));
  }
  return out;
}

export interface PeriodTotals {
  period: string;
  consignorId: number | null;
  consignorName: string | null;
  entries: number;
  incomplete: number;
  grossSaleCents: number;
  commissionCents: number;
  commissionGstCents: number;
  commissionExGstCents: number;
  consignorPayableCents: number;
}

/** Totals per period and consignor: what LOFI used to journal by hand. Incomplete entries are counted, not summed. */
export function periodTotals(entries: Pick<ConsignmentEntry, "accountingPeriod" | "consignorId" | "consignorName" | "status" | "grossSaleCents" | "commissionCents" | "commissionGstCents" | "consignorPayableCents">[]): PeriodTotals[] {
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
      commissionCents: 0,
      commissionGstCents: 0,
      commissionExGstCents: 0,
      consignorPayableCents: 0,
    };
    t.entries++;
    if (e.status !== "calculated") t.incomplete++;
    else {
      t.grossSaleCents += e.grossSaleCents;
      t.commissionCents += e.commissionCents ?? 0;
      t.commissionGstCents += e.commissionGstCents ?? 0;
      t.consignorPayableCents += e.consignorPayableCents ?? 0;
      t.commissionExGstCents = t.commissionCents - t.commissionGstCents;
    }
    map.set(key, t);
  }
  return [...map.values()].sort((a, b) => b.period.localeCompare(a.period) || (a.consignorName ?? "").localeCompare(b.consignorName ?? ""));
}
