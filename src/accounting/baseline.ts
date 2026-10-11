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
import { rescaleOrder, type StockResolver } from "../rules/engine";
import type { NormalisedPayout, OrderSale, SaleLine } from "../types";
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

/** Category for one sold item line, from ownership and destination only. */
export function itemCategory(order: OrderSale, line: SaleLine, resolve: StockResolver): { category: LogicalCategory; reason: string } {
  if (line.placeholder) return { category: "UNCLASSIFIED", reason: "order details unavailable" };
  const item = resolve(line.sku);
  if (!item) return { category: "UNCLASSIFIED", reason: line.sku ? `ownership of ${line.sku} unknown` : "no SKU" };
  if (item.ownership === "consignment") return { category: "CONSIGNMENT_SALES_NO_GST", reason: "consignment: full sale amount, no GST" };
  const dest = order.destinationCountry?.toUpperCase() ?? null;
  if (dest === null || order.shippingProgram === "unknown") return { category: "UNCLASSIFIED", reason: "destination unknown" };
  if (dest !== "AU") {
    return {
      category: "SALES_OVERSEAS_NO_GST",
      reason:
        order.shippingProgram === "ebay_international"
          ? "LOFI-owned, sold overseas via eBay International Shipping (historical treatment; C2 still unresolved)"
          : `LOFI-owned, sold to ${dest}`,
    };
  }
  return { category: "SALES_DOMESTIC_GST", reason: "LOFI-owned, sold in Australia" };
}

/**
 * Items and shipping of one order. Shipping follows the items; when an order
 * mixes categories, shipping is shared across them in proportion to the item
 * amounts (an assumption: the historical method didn't split shipping).
 */
function orderLines(order: OrderSale, resolve: StockResolver, sourceTransactionId: string | null): BaselineLine[] {
  const items: BaselineLine[] = order.lines.map((l) => {
    const c = itemCategory(order, l, resolve);
    return { ...c, cents: l.grossCents, kind: "item", orderId: order.orderId, orderName: order.orderName, lineId: l.lineId, sku: l.sku, sourceTransactionId };
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
      category: payout.channel === "ebay" ? "EBAY_FEES" : "SHOPIFY_FEES",
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
