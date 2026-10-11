// Stage 1 of LOFI's historical method: split a payout into its components and
// give each a logical category, the way staff did by hand in QuickBooks.
//
//   LOFI-owned, Australia      -> SALES_DOMESTIC_GST
//   LOFI-owned, overseas       -> SALES_OVERSEAS_NO_GST
//   Consignment (anywhere)     -> CONSIGNMENT_SALES_NO_GST  (+ consignment ledger)
//   eBay / Shopify fees        -> EBAY_FEES / SHOPIFY_FEES
//   Adjustments                -> MARKETPLACE_ADJUSTMENTS
//   Refunds                    -> REFUND, reversing the original category
//
// Only ownership and destination are needed. Missing facts give
// UNCLASSIFIED, never a guess. The lines always add up to the reconstructed
// payout, so a balanced payout gives a complete-looking split; completeness
// is reported separately. A balanced payout is necessary but not sufficient
// for accounting correctness.

import { allocate } from "../money";
import { isDivision66Candidate, rescaleOrder, type StockResolver } from "../rules/engine";
import type { FeeCategory, NormalisedPayout, OrderSale, SaleLine, StockItem } from "../types";
import { HISTORICAL_BASELINE, type LogicalCategory } from "./categories";

export interface BaselineLine {
  category: LogicalCategory;
  /** Signed cents as the line affects the payout. */
  cents: number;
  kind: "item" | "shipping" | "fee" | "adjustment" | "refund";
  orderId: string | null;
  orderName: string | null;
  lineId: string | null;
  sku: string | null;
  /** For refunds: the category being reversed. */
  reversesCategory?: LogicalCategory;
  /** Which row of PAYOUT_CLASSIFICATION_RULES decided an item line. */
  ruleId?: string;
  /** Division 66: only assessed when acquisition facts exist. */
  division66?: "candidate" | "not_applicable" | "not_assessed";
  reason: string;
  sourceTransactionId: string | null;
}

export interface BaselineSplit {
  recipe: typeof HISTORICAL_BASELINE.id;
  lines: BaselineLine[];
  totals: Partial<Record<LogicalCategory, number>>;
  sumCents: number;
  unclassifiedCount: number;
  complete: boolean;
}

/** The facts a sold line is classified from (and nothing else). */
export interface LineFacts {
  orderDetailsMissing: boolean;
  ownership: "owned" | "consignment" | null;
  /** "referred" = staff sent the destination question to manual review. */
  destination: "AU" | "overseas" | "unknown" | "referred";
  ebayInternationalShipping: boolean;
}

export interface ClassificationRule {
  id: string;
  when: string;
  test: (f: LineFacts) => boolean;
  category: LogicalCategory;
}

/**
 * THE payout classification table (historical baseline). Ordered: the first
 * rule that matches wins. Change it only with the accountant's agreement;
 * the tests pin every row.
 */
export const PAYOUT_CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  { id: "R1", when: "Order details unavailable", test: (f) => f.orderDetailsMissing, category: "UNCLASSIFIED" },
  { id: "R2", when: "Ownership unknown (no stock record, no prefix rule, not L-)", test: (f) => f.ownership === null, category: "UNCLASSIFIED" },
  { id: "R3", when: "Consignment, any destination", test: (f) => f.ownership === "consignment", category: "CONSIGNMENT_SALES_NO_GST" },
  { id: "R4", when: "LOFI-owned, destination unknown or referred for review", test: (f) => f.destination === "unknown" || f.destination === "referred", category: "UNCLASSIFIED" },
  { id: "R5", when: "LOFI-owned, sent overseas (including eBay International Shipping)", test: (f) => f.destination === "overseas", category: "SALES_OVERSEAS_NO_GST" },
  { id: "R6", when: "LOFI-owned, sold in Australia", test: (f) => f.destination === "AU", category: "SALES_DOMESTIC_GST" },
];

/** Fee categories by channel. Configured, not inferred. */
export const FEE_CATEGORY_MAP: Record<"ebay" | "shopify", Record<FeeCategory, LogicalCategory>> = {
  ebay: { marketplace: "EBAY_FEES", payment: "EBAY_FEES", advertising: "EBAY_FEES", shipping_label: "EBAY_FEES", other: "EBAY_FEES" },
  shopify: { marketplace: "SHOPIFY_FEES", payment: "SHOPIFY_FEES", advertising: "SHOPIFY_FEES", shipping_label: "SHOPIFY_FEES", other: "SHOPIFY_FEES" },
};

export function lineFacts(order: OrderSale, line: SaleLine, item: StockItem | null): LineFacts {
  const dest = order.destinationCountry?.toUpperCase() ?? null;
  return {
    orderDetailsMissing: !!line.placeholder,
    ownership: item?.ownership ?? null,
    destination: order.destinationReferred
      ? "referred"
      : dest === null || order.shippingProgram === "unknown"
        ? "unknown"
        : dest === "AU"
          ? "AU"
          : "overseas",
    ebayInternationalShipping: order.shippingProgram === "ebay_international",
  };
}

/** Division 66 status of a line: only assessed when acquisition facts exist. */
export function division66Status(item: StockItem | null): "candidate" | "not_applicable" | "not_assessed" {
  if (!item || item.ownership !== "owned") return item ? "not_applicable" : "not_assessed";
  if (!item.acquiredFrom) return "not_assessed";
  if (item.acquiredFrom === "registered_supplier") return "not_applicable";
  if (item.acquiredFrom === "other") return "not_assessed";
  if (!item.condition) return "not_assessed";
  return isDivision66Candidate(item) ? "candidate" : "not_applicable";
}

/** Category for one sold item line: the first matching rule in the table. */
export function itemCategory(order: OrderSale, line: SaleLine, resolve: StockResolver): { category: LogicalCategory; reason: string; ruleId: string } {
  const item = line.placeholder ? null : resolve(line.sku);
  const f = lineFacts(order, line, item);
  const rule = PAYOUT_CLASSIFICATION_RULES.find((r) => r.test(f))!;
  const extra = f.ebayInternationalShipping && rule.id === "R5" ? " (C2 still unresolved in the draft scenarios)" : "";
  return { category: rule.category, reason: `${rule.id}: ${rule.when}${extra}`, ruleId: rule.id };
}

/**
 * Items and shipping of one order. Shipping follows the items; when an order
 * mixes categories, shipping is shared across them in proportion to the item
 * amounts (an assumption: the historical method didn't split shipping).
 */
function orderLines(order: OrderSale, resolve: StockResolver, sourceTransactionId: string | null): BaselineLine[] {
  const items: BaselineLine[] = order.lines.map((l) => {
    const c = itemCategory(order, l, resolve);
    const d66 = division66Status(l.placeholder ? null : resolve(l.sku));
    return { ...c, division66: d66, cents: l.grossCents, kind: "item", orderId: order.orderId, orderName: order.orderName, lineId: l.lineId, sku: l.sku, sourceTransactionId };
  });
  if (order.shippingCents === 0) return items;
  const parts = allocate(order.shippingCents, items.map((i) => Math.abs(i.cents)));
  const byCat = new Map<LogicalCategory, number>();
  items.forEach((i, k) => byCat.set(i.category, (byCat.get(i.category) ?? 0) + (parts[k] ?? 0)));
  const shipping: BaselineLine[] = [...byCat].map(([category, cents]) => ({
    category,
    cents,
    kind: "shipping",
    orderId: order.orderId,
    orderName: order.orderName,
    lineId: `${order.orderId}:shipping`,
    sku: null,
    reason: byCat.size > 1 ? "shipping shared across the order's item categories" : "shipping follows the items",
    sourceTransactionId,
  }));
  return [...items, ...shipping];
}

export function baselineSplit(payout: NormalisedPayout, resolve: StockResolver): BaselineSplit {
  const lines: BaselineLine[] = [];
  for (const o of payout.sales) lines.push(...orderLines(o, resolve, o.sources[0]?.transactionId ?? null));
  for (const r of payout.refunds) {
    if (!r.order) {
      lines.push({
        category: "UNCLASSIFIED",
        cents: -r.cents,
        kind: "refund",
        orderId: r.orderId,
        orderName: r.orderName,
        lineId: null,
        sku: null,
        reason: "refund's original order not available",
        sourceTransactionId: r.source.transactionId,
      });
      continue;
    }
    for (const l of orderLines(rescaleOrder(r.order, -r.cents), resolve, r.source.transactionId)) {
      lines.push({
        ...l,
        kind: "refund",
        category: l.category === "UNCLASSIFIED" ? "UNCLASSIFIED" : "REFUND",
        reversesCategory: l.category === "UNCLASSIFIED" ? undefined : l.category,
        reason: `refund of: ${l.reason}`,
      });
    }
  }
  for (const f of payout.fees) {
    lines.push({
      category: FEE_CATEGORY_MAP[payout.channel][f.category],
      cents: -f.cents,
      kind: "fee",
      orderId: f.orderId,
      orderName: null,
      lineId: null,
      sku: null,
      reason: f.description,
      sourceTransactionId: f.source.transactionId,
    });
  }
  for (const a of payout.adjustments) {
    lines.push({
      category: a.supported ? "MARKETPLACE_ADJUSTMENTS" : "UNCLASSIFIED",
      cents: a.cents,
      kind: "adjustment",
      orderId: a.orderId,
      orderName: null,
      lineId: null,
      sku: null,
      reason: a.supported ? a.description : `unsupported transaction type ${a.type}`,
      sourceTransactionId: a.source.transactionId,
    });
  }
  const totals: Partial<Record<LogicalCategory, number>> = {};
  for (const l of lines) totals[l.category] = (totals[l.category] ?? 0) + l.cents;
  const unclassifiedCount = lines.filter((l) => l.category === "UNCLASSIFIED").length;
  return {
    recipe: HISTORICAL_BASELINE.id,
    lines,
    totals,
    sumCents: lines.reduce((a, l) => a + l.cents, 0),
    unclassifiedCount,
    complete: unclassifiedCount === 0,
  };
}
