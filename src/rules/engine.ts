// Deterministic GST rules engine. No AI, no guessing: each sale line either
// matches one of LOFI's scenarios or goes to the review queue.
//
// Order of precedence (sign-off doc, "how rules are applied"):
//   1. A manual override recorded against the item.
//   2. Destination: overseas -> a C scenario.
//   3. Ownership and source -> A1–A3 or B1–B2.
//   4. No match -> review (D5).

import { allocate, fmt, gstInclusive } from "../money";
import type {
  LineClassification,
  OrderSale,
  PostingLine,
  SaleLine,
  ScenarioCode,
  StockItem,
} from "../types";
import {
  ACCOUNTS,
  CONSIGNMENT_SHIPPING_BELONGS_TO_LOFI,
  DIV66_THRESHOLD_CENTS,
  EBAY_INTERNATIONAL_SHIPPING_TREATMENT,
  SCENARIOS,
} from "./config";

export type StockResolver = (sku: string | null) => StockItem | null;

const isOverseas = (o: OrderSale) =>
  o.destinationCountry !== null && o.destinationCountry.toUpperCase() !== "AU";

function approvalFor(code: ScenarioCode): LineClassification["approval"] {
  if (code === "REVIEW") return "review";
  return SCENARIOS[code].signedOff ? "approved" : "draft";
}

function base(order: OrderSale, line: SaleLine) {
  return {
    orderId: order.orderId,
    orderName: order.orderName,
    lineId: line.lineId,
    sku: line.sku,
    title: line.title,
    grossCents: line.grossCents,
  };
}

function review(order: OrderSale, line: SaleLine, reason: string, flags: string[] = []): LineClassification {
  return {
    ...base(order, line),
    scenario: "REVIEW",
    approval: "review",
    reason,
    gstCents: 0,
    postings: [],
    notionalItcCents: 0,
    flags,
  };
}

function result(
  order: OrderSale,
  line: SaleLine,
  scenario: ScenarioCode,
  reason: string,
  postings: PostingLine[],
  extra: { notionalItcCents?: number; flags?: string[]; forceReview?: boolean } = {},
): LineClassification {
  const flags = [...(extra.flags ?? [])];
  const pending = SCENARIOS[scenario].pending;
  if (pending && !SCENARIOS[scenario].signedOff) flags.push(`Pending sign-off: ${pending}`);
  if (order.buyerCurrency && order.buyerCurrency !== "AUD") {
    flags.push(
      `Buyer paid in ${order.buyerCurrency}: GST uses the platform's AUD amount until LOFI's conversion-rate policy (C4) is approved`,
    );
  }
  return {
    ...base(order, line),
    scenario,
    approval: extra.forceReview ? "review" : approvalFor(scenario),
    reason,
    gstCents: postings.reduce((a, p) => a + p.gstCents, 0),
    postings,
    notionalItcCents: extra.notionalItcCents ?? 0,
    flags,
  };
}

const taxable = (account: string, gross: number, memo?: string): PostingLine => ({
  account,
  taxCode: "GST",
  grossCents: gross,
  gstCents: gstInclusive(gross),
  memo,
});
const exportFree = (account: string, gross: number, memo?: string): PostingLine => ({
  account,
  taxCode: "GST_FREE_EXPORT",
  grossCents: gross,
  gstCents: 0,
  memo,
});
const noGst = (account: string, gross: number, memo?: string): PostingLine => ({
  account,
  taxCode: "NO_GST",
  grossCents: gross,
  gstCents: 0,
  memo,
});

/** Commission LOFI keeps on a consigned line, GST-inclusive cents. */
export function commissionFor(item: StockItem, lineGross: number, quantity: number): number | null {
  const type = item.commissionType ?? item.consignor?.commissionType;
  const value = item.commissionValue ?? item.consignor?.commissionValue;
  if (type === undefined || type === null || value === undefined || value === null) return null;
  // Refunds carry negative amounts: compute on the magnitude, keep the sign.
  const sign = lineGross < 0 ? -1 : 1;
  const abs = Math.abs(lineGross);
  const c = type === "percent" ? Math.round((abs * value) / 100) : Math.round(value * 100) * quantity;
  return sign * Math.min(c, abs);
}

/**
 * Division 66 notional input tax credit available on this sale.
 * Over $300: claimed in the period of resale, capped at the GST on the sale.
 * $300 or less: claimed when bought, so nothing here.
 */
export function div66Credit(item: StockItem, saleGstCents: number, flags: string[]): number {
  if (item.purchaseCents === null || item.purchaseCents === undefined) {
    flags.push("Purchase price missing: Division 66 credit can't be worked out");
    return 0;
  }
  if (item.div66RecordComplete === false) {
    flags.push("Division 66 record incomplete (seller name/address, description, date, price)");
  }
  if (item.purchaseCents <= DIV66_THRESHOLD_CENTS) {
    flags.push("Purchase $300 or under: Division 66 credit belongs to the purchase period");
    return 0;
  }
  const notional = gstInclusive(item.purchaseCents);
  const sign = saleGstCents < 0 ? -1 : 1; // refund reverses the credit
  return sign * Math.min(notional, Math.abs(saleGstCents));
}

/** Classify one sale line (never shipping; see classifyShipping). */
export function classifyLine(order: OrderSale, line: SaleLine, item: StockItem | null): LineClassification {
  if (!item) {
    return review(order, line, line.sku ? `No stock record or SKU prefix rule for SKU "${line.sku}"` : "Line has no SKU");
  }
  const flags: string[] = [];
  if (item.source === "prefix") flags.push("Classified from SKU prefix default, not an individual stock record");

  const scenario = item.overrideScenario ?? pickScenario(order, item);
  if (item.overrideScenario) flags.push(`Manual override to ${item.overrideScenario}`);
  const g = line.grossCents;

  switch (scenario) {
    case "A1":
      return result(order, line, "A1", "Owned stock, taxable sale in Australia", [taxable(ACCOUNTS.salesStock, g)], { flags });

    case "A2":
    case "A3": {
      const sale = taxable(ACCOUNTS.salesStock, g);
      const itc = div66Credit(item, sale.gstCents, flags);
      const why = scenario === "A2" ? "Second-hand from a private seller, taxable sale" : "Trade-in item resold, taxable sale";
      return result(order, line, scenario, why, [sale], { notionalItcCents: itc, flags });
    }

    case "B1":
    case "B2_AGENCY":
    case "C3": {
      const commission = commissionFor(item, g, line.quantity);
      if (commission === null) return review(order, line, "Consigned item has no commission rate", flags);
      const payable = g - commission;
      const commissionPosting =
        scenario === "C3" && item.consignor?.agreementType === "153B"
          ? exportFree(ACCOUNTS.exportSales, g, "153-B consignment exported")
          : taxable(ACCOUNTS.commissionIncome, commission, "LOFI commission");
      if (scenario === "C3" && item.consignor?.agreementType === "153B") {
        return result(order, line, "C3", "Consigned (153-B) item exported: LOFI's export sale", [commissionPosting], {
          flags: [...flags, `Consignor's supply to LOFI (${fmt(payable)}) to be recorded as a bill`],
        });
      }
      const why =
        scenario === "B1"
          ? "Consignment for a non-registered consignor: GST on commission only"
          : scenario === "B2_AGENCY"
            ? "Consignment, registered consignor, agency: consignor reports GST on the sale"
            : "Consigned item exported: proceeds to consignor, GST on commission";
      return result(
        order,
        line,
        scenario,
        why,
        [noGst(ACCOUNTS.consignorPayable, payable, "Owed to consignor"), commissionPosting],
        { flags },
      );
    }

    case "B2_153B": {
      const commission = commissionFor(item, g, line.quantity);
      const payable = commission === null ? null : g - commission;
      return result(order, line, "B2_153B", "Consignment under 153-B: LOFI reports GST on the full sale", [taxable(ACCOUNTS.salesStock, g)], {
        flags: [
          ...flags,
          payable === null
            ? "Consignor's supply to LOFI to be recorded as a bill (no commission rate on file)"
            : `Consignor's taxable supply to LOFI to be recorded as a bill: ${fmt(payable)} incl. GST`,
        ],
      });
    }

    case "C1": {
      const postings = [exportFree(ACCOUNTS.exportSales, g)];
      const extraFlags = [...flags, "Keep export evidence (label, tracking, customs declaration)"];
      let itc = 0;
      if (item.ownership === "owned" && (item.acquiredFrom === "private_seller" || item.acquiredFrom === "trade_in")) {
        itc = div66Credit(item, 0, extraFlags); // capped at GST on the sale, which is nil
      }
      return result(order, line, "C1", `Exported to ${order.destinationCountry} by LOFI: GST-free`, postings, {
        notionalItcCents: itc,
        flags: extraFlags,
      });
    }

    case "C2": {
      if (EBAY_INTERNATIONAL_SHIPPING_TREATMENT === "UNRESOLVED") {
        return result(order, line, "C2", "eBay International Shipping: treatment not yet decided", [], {
          flags: [...flags, `Final destination ${order.destinationCountry}`],
          forceReview: true,
        });
      }
      const p =
        EBAY_INTERNATIONAL_SHIPPING_TREATMENT === "GST_FREE_EXPORT"
          ? exportFree(ACCOUNTS.exportSales, g)
          : taxable(ACCOUNTS.salesStock, g);
      return result(order, line, "C2", "eBay International Shipping", [p], { flags });
    }

    case "REVIEW":
      return review(order, line, "Marked for manual review", flags);
  }
}

function pickScenario(order: OrderSale, item: StockItem): ScenarioCode {
  if (isOverseas(order)) {
    if (order.shippingProgram === "ebay_international") return "C2";
    return item.ownership === "consignment" ? "C3" : "C1";
  }
  if (item.ownership === "owned") {
    if (item.acquiredFrom === "private_seller") return "A2";
    if (item.acquiredFrom === "trade_in") return "A3";
    return "A1";
  }
  // consignment
  if (!item.consignor) return "REVIEW";
  if (!item.consignor.gstRegistered) return "B1";
  return item.consignor.agreementType === "153B" ? "B2_153B" : "B2_AGENCY";
}

/** D2: shipping follows the item. */
export function classifyShipping(order: OrderSale, lineResults: LineClassification[]): LineClassification | null {
  if (order.shippingCents === 0) return null;
  const line: SaleLine = {
    lineId: `${order.orderId}:shipping`,
    sku: null,
    title: "Shipping charged to buyer",
    quantity: 1,
    grossCents: order.shippingCents,
  };
  const scenarios = new Set(lineResults.map((r) => r.scenario));
  if (scenarios.has("REVIEW") || (scenarios.has("C2") && EBAY_INTERNATIONAL_SHIPPING_TREATMENT === "UNRESOLVED")) {
    return review(order, line, "Shipping follows the items, and an item on this order needs review");
  }
  const flags: string[] = [];
  const hasConsignment = [...scenarios].some((s) => s.startsWith("B") || s === "C3");
  if (hasConsignment) {
    flags.push(
      CONSIGNMENT_SHIPPING_BELONGS_TO_LOFI
        ? "Pending sign-off (D2): shipping on a consignment sale treated as LOFI income"
        : "Pending sign-off (D2): shipping on a consignment sale passed to consignor",
    );
  }
  const exported = [...scenarios].every((s) => s === "C1" || s === "C3" || s === "C2");
  const p = exported
    ? exportFree(ACCOUNTS.shippingIncome, line.grossCents)
    : taxable(ACCOUNTS.shippingIncome, line.grossCents);
  return {
    ...base(order, line),
    scenario: lineResults[0]?.scenario ?? "REVIEW",
    approval: lineResults.some((r) => r.approval !== "approved") || hasConsignment ? "draft" : "approved",
    reason: exported ? "Shipping on an export: GST-free" : "Shipping on a domestic sale: taxable",
    gstCents: p.gstCents,
    postings: [p],
    notionalItcCents: 0,
    flags,
  };
}

/** Classify a whole order: every line, then shipping. */
export function classifyOrder(order: OrderSale, resolve: StockResolver): LineClassification[] {
  const lines = order.lines.map((l) => classifyLine(order, l, resolve(l.sku)));
  const ship = classifyShipping(order, lines);
  return ship ? [...lines, ship] : lines;
}

/**
 * Spread `newGross` across an order's lines and shipping in proportion to the
 * original amounts. Used for refunds (D3, reversed with the same scenarios)
 * and when a payout only carries part of an order's payment.
 */
export function rescaleOrder(order: OrderSale, newGross: number): OrderSale {
  const weights = [...order.lines.map((l) => l.grossCents), order.shippingCents];
  const parts = allocate(newGross, weights);
  return {
    ...order,
    grossCents: newGross,
    lines: order.lines.map((l, i) => ({ ...l, grossCents: parts[i] ?? 0 })),
    shippingCents: parts[parts.length - 1] ?? 0,
  };
}
