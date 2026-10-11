// Deterministic GST rules engine. No AI, no guessing: each sale line either
// matches one of LOFI's scenarios or goes to the review queue.
//
// The engine reads facts about the stock item (ownership, who it was bought
// from, condition, consignor) and derives the scenario. Every result carries
// an explanation: the facts it used, in order, and the conclusion.
//
// Order of precedence (sign-off doc, "how rules are applied"):
//   1. A manual override recorded against the item.
//   2. Destination: overseas -> a C scenario. Unknown destination -> review.
//   3. Ownership and source -> A1–A3 or B1–B2.
//   4. Any fact missing -> review (D5).

import { allocate, applyBasisPoints, fmt, gstInclusive, percentToBasisPoints, toCents } from "../money";
import type {
  Consignor,
  Issue,
  IssueCode,
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
  TRADE_IN_TREATMENT,
} from "./config";

export type StockResolver = (sku: string | null) => StockItem | null;

const OWNERSHIP_LABEL = { owned: "LOFI", consignment: "consignment" } as const;
const SOURCE_LABEL = {
  registered_supplier: "gst_registered_supplier",
  private_seller: "private_non_gst_seller",
  trade_in: "trade_in",
  other: "other",
} as const;

function approvalFor(code: ScenarioCode): LineClassification["approval"] {
  if (code === "REVIEW") return "review";
  return SCENARIOS[code].signedOff ? "approved" : "draft";
}

function base(order: OrderSale, line: SaleLine, kind: LineClassification["kind"] = "item") {
  return {
    orderId: order.orderId,
    orderName: order.orderName,
    lineId: line.lineId,
    kind,
    sku: line.sku,
    title: line.title,
    grossCents: line.grossCents,
    discountCents: line.discountCents,
    sources: order.sources,
  };
}

const issue = (
  order: OrderSale,
  line: SaleLine,
  code: IssueCode,
  severity: Issue["severity"],
  message: string,
  extra: Partial<Issue> = {},
): Issue => ({ code, severity, message, orderId: order.orderId, lineId: line.lineId, sku: line.sku, ...extra });

function review(
  order: OrderSale,
  line: SaleLine,
  code: IssueCode,
  reason: string,
  why: string[],
  flags: string[] = [],
  extra: Partial<Issue> = {},
): LineClassification {
  return {
    ...base(order, line),
    scenario: "REVIEW",
    approval: "review",
    reason,
    explanation: [...why, `→ needs review: ${reason}`],
    gstCents: 0,
    postings: [],
    notionalItcCents: 0,
    division66Candidate: false,
    flags,
    issues: [issue(order, line, code, "blocking", reason, extra)],
  };
}

interface ResultExtra {
  notionalItcCents?: number;
  division66Candidate?: boolean;
  flags?: string[];
  issues?: Issue[];
  /** A scenario whose treatment is still undecided: block until a person looks. */
  unresolved?: string;
}

function result(
  order: OrderSale,
  line: SaleLine,
  scenario: ScenarioCode,
  reason: string,
  why: string[],
  postings: PostingLine[],
  extra: ResultExtra = {},
): LineClassification {
  const flags = [...(extra.flags ?? [])];
  const issues = [...(extra.issues ?? [])];
  const def = SCENARIOS[scenario];
  if (!def.signedOff) {
    const msg = `${scenario} (${def.name}) is a draft until the accountant signs it off${def.pending ? `: ${def.pending}` : ""}`;
    issues.push(issue(order, line, "unsigned_scenario", "signoff", msg, { sku: null, lineId: null, orderId: null }));
  }
  if (extra.unresolved) issues.push(issue(order, line, "unresolved_scenario", "blocking", extra.unresolved));
  if (order.buyerCurrency && order.buyerCurrency !== "AUD") {
    const msg = `Buyer paid in ${order.buyerCurrency}: GST uses the platform's AUD amount until LOFI's conversion-rate policy (C4) is approved`;
    flags.push(msg);
    issues.push(issue(order, line, "fx_policy_pending", "signoff", msg));
  }
  const gstCents = postings.reduce((a, p) => a + p.gstCents, 0);
  const conclusion = extra.unresolved
    ? `→ ${scenario}, held for review: ${extra.unresolved}`
    : `→ ${scenario}: ${reason}${def.signedOff ? "" : " (draft, not signed off)"}`;
  return {
    ...base(order, line),
    scenario,
    approval: extra.unresolved ? "review" : approvalFor(scenario),
    reason,
    explanation: [
      ...why,
      conclusion,
      ...(extra.division66Candidate ? ["→ Division 66 candidate"] : []),
    ],
    gstCents,
    postings,
    notionalItcCents: extra.notionalItcCents ?? 0,
    division66Candidate: extra.division66Candidate ?? false,
    flags,
    issues,
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
  const c = type === "percent" ? applyBasisPoints(abs, percentToBasisPoints(value)) : toCents(value) * quantity;
  return sign * Math.min(c, abs);
}

/**
 * Division 66 applies to second-hand goods LOFI bought for resale from someone
 * who didn't charge GST: a private seller or a trade-in. It is derived from
 * the stock facts; nobody tags an item "Division 66".
 */
export function isDivision66Candidate(item: StockItem): boolean {
  return (
    item.ownership === "owned" &&
    (item.acquiredFrom === "private_seller" || item.acquiredFrom === "trade_in") &&
    item.condition === "secondhand"
  );
}

/**
 * Division 66 notional input tax credit available on this sale.
 * Over $300: claimed in the period of resale, capped at the GST on the sale.
 * $300 or less: claimed when bought, so nothing here.
 * Returns null when the purchase price is missing.
 */
export function div66Credit(item: StockItem, saleGstCents: number, flags: string[]): number | null {
  if (item.purchaseCents === null || item.purchaseCents === undefined) return null;
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

type Pick =
  | { scenario: Exclude<ScenarioCode, "REVIEW">; why: string[] }
  | { scenario: "REVIEW"; why: string[]; code: IssueCode; reason: string; extra?: Partial<Issue> };

/** Facts -> scenario, recording each fact used. */
export function pickScenario(order: OrderSale, item: StockItem): Pick {
  const why: string[] = [];
  const dest = order.destinationCountry?.toUpperCase() ?? null;
  if (dest === null || order.shippingProgram === "unknown") {
    return {
      scenario: "REVIEW",
      why: [...why, "destination = unknown"],
      code: "unknown_destination",
      reason: "Destination unknown: the platform gave no shipping country (local pickup?)",
    };
  }
  why.push(
    `destination = ${dest}${order.shippingProgram === "ebay_international" ? " via eBay International Shipping" : ""}${
      order.destinationSource === "staff" ? " (recorded by staff)" : ""
    }`,
  );
  why.push(`ownership = ${OWNERSHIP_LABEL[item.ownership]}`);

  const consignorFacts = (): Pick | null => {
    if (!item.consignor) {
      return {
        scenario: "REVIEW",
        why: [...why, item.consignorMissingId ? `consignor #${item.consignorMissingId} not found` : "consignor = unknown"],
        code: "unknown_consignor",
        reason: "Consigned item has no consignor on record",
      };
    }
    why.push(`consignor = ${item.consignor.name} (#${item.consignor.id})`);
    return null;
  };

  if (dest !== "AU") {
    if (order.shippingProgram === "ebay_international") return { scenario: "C2", why };
    if (item.ownership === "consignment") {
      const missing = consignorFacts();
      if (missing) return missing;
      const c = item.consignor!;
      const gst = consignorGstFacts(c, why);
      if (gst) return gst;
      if (c.australianGstRegistered) {
        const agreement = consignorAgreementFacts(c, why);
        if (agreement) return agreement;
      } else {
        why.push(`agreement = ${c.agreementType ?? "not recorded (not needed for a non-registered consignor)"}`);
      }
      return { scenario: "C3", why };
    }
    if (item.acquiredFrom) why.push(`source_type = ${SOURCE_LABEL[item.acquiredFrom]}`);
    return { scenario: "C1", why };
  }

  if (item.ownership === "owned") {
    if (!item.acquiredFrom) {
      return {
        scenario: "REVIEW",
        why: [...why, "source_type = unknown"],
        code: "unknown_acquisition_source",
        reason: "LOFI-owned item: who it was bought from isn't recorded",
      };
    }
    why.push(`source_type = ${SOURCE_LABEL[item.acquiredFrom]}`);
    switch (item.acquiredFrom) {
      case "registered_supplier":
        why.push("supplier_gst_registered = yes");
        return { scenario: "A1", why };
      case "other":
        return {
          scenario: "REVIEW",
          why,
          code: "manual_review",
          reason: "Acquired from 'other': no scenario covers this, a person must classify it",
        };
      case "private_seller":
      case "trade_in": {
        if (!item.condition) {
          if (item.acquiredFrom === "trade_in") return { scenario: "A3", why: [...why, "condition = unknown"] };
          return {
            scenario: "REVIEW",
            why: [...why, "condition = unknown"],
            code: "unknown_condition",
            reason: "Bought from a private seller: new or second-hand isn't recorded (needed for Division 66)",
          };
        }
        why.push(`condition = ${item.condition}`);
        if (item.acquiredFrom === "trade_in") return { scenario: "A3", why };
        if (item.condition === "secondhand") return { scenario: "A2", why };
        return {
          scenario: "REVIEW",
          why,
          code: "manual_review",
          reason: "New goods bought from a private seller: no draft scenario covers this",
        };
      }
    }
  }

  // consignment
  const missing = consignorFacts();
  if (missing) return missing;
  const c = item.consignor!;
  const gst = consignorGstFacts(c, why);
  if (gst) return gst;
  if (!c.australianGstRegistered) {
    why.push(`agreement = ${c.agreementType ?? "not recorded (not needed for a non-registered consignor)"}`);
    return { scenario: "B1", why };
  }
  const agreement = consignorAgreementFacts(c, why);
  if (agreement) return agreement;
  return { scenario: c.agreementType === "153B" ? "B2_153B" : "B2_AGENCY", why };
}

/** Australian GST registration of a consignor: unknown -> review. */
function consignorGstFacts(c: Consignor, why: string[]): Pick | null {
  if (c.australianGstRegistered === null) {
    return {
      scenario: "REVIEW",
      why: [...why, `consignor_country = ${c.country ?? "unknown"}`, "australian_gst_registered = unknown"],
      code: "unknown_consignor_gst_status",
      reason: `Consignor ${c.name}: Australian GST registration isn't recorded`,
      extra: { consignorId: c.id },
    };
  }
  why.push(`consignor_country = ${c.country ?? "unknown"}`);
  why.push(
    `australian_gst_registered = ${c.australianGstRegistered ? "yes" : "no"}${
      c.australianGstBasis === "intake_default_overseas" ? " (intake default for an overseas consignor)" : ""
    }`,
  );
  return null;
}

/** Agency vs 153-B for a GST-registered consignor: never defaulted. */
function consignorAgreementFacts(c: Consignor, why: string[]): Pick | null {
  if (c.agreementType === null) {
    return {
      scenario: "REVIEW",
      why: [...why, "agreement = unknown"],
      code: "unknown_consignor_agreement",
      reason: `Consignor ${c.name} is GST-registered: agency or Subdivision 153-B isn't recorded`,
      extra: { consignorId: c.id },
    };
  }
  why.push(`agreement = ${c.agreementType}`);
  return null;
}

/** Classify one sale line (never shipping; see classifyShipping). */
export function classifyLine(order: OrderSale, line: SaleLine, item: StockItem | null): LineClassification {
  if (line.placeholder) {
    // The order-level "order details missing" issue already explains this line.
    const r = review(order, line, "order_details_missing", "Order details unavailable: items can't be classified", ["order details = unavailable"]);
    return { ...r, issues: [] };
  }
  if (!line.sku) return review(order, line, "unknown_sku", "Line has no SKU", ["sku = none"]);
  if (!item) {
    return review(
      order,
      line,
      "unknown_stock_record",
      line.skuFromListing
        ? `No SKU on the eBay listing, and no facts recorded for listing ${line.sku}`
        : `No stock record or SKU prefix rule for SKU "${line.sku}"`,
      [line.skuFromListing ? `sku = none; eBay listing ${line.sku}` : `sku = ${line.sku}`, "stock record = none"],
    );
  }
  const flags: string[] = [];
  const why: string[] = [
    ...(line.skuFromListing ? [`sku = none on the listing; keyed on eBay listing ID ${line.sku}`] : []),
    item.source === "item" ? `stock record ${item.sku}` : `SKU prefix rule "${item.prefix ?? "?"}" (no individual record)`,
  ];
  if (line.skuFromListing) flags.push("No SKU on the eBay listing: facts are recorded against the listing ID");
  if (item.source === "prefix") flags.push("Classified from SKU prefix default, not an individual stock record");

  let scenario: ScenarioCode;
  if (item.overrideScenario) {
    scenario = item.overrideScenario;
    why.push(`manual override = ${item.overrideScenario}`);
    flags.push(`Manual override to ${item.overrideScenario}`);
  } else {
    const p = pickScenario(order, item);
    why.push(...p.why);
    if (p.scenario === "REVIEW") return review(order, line, p.code, p.reason, why, flags, p.extra);
    scenario = p.scenario;
  }
  const g = line.grossCents;

  switch (scenario) {
    case "A1":
      return result(order, line, "A1", "LOFI-owned stock, normal taxable sale in Australia", why, [taxable(ACCOUNTS.salesStock, g)], { flags });

    case "A2":
    case "A3": {
      const sale = taxable(ACCOUNTS.salesStock, g);
      const candidate = isDivision66Candidate(item);
      const issues: Issue[] = [];
      let itc = 0;
      if (candidate) {
        const c = div66Credit(item, sale.gstCents, flags);
        if (c === null) {
          issues.push(issue(order, line, "unknown_purchase_price", "blocking", "Purchase price missing: Division 66 credit can't be worked out"));
        } else itc = c;
      }
      const why2 = scenario === "A2" ? "Second-hand from a private seller: normal taxable sale" : "Trade-in item resold: normal taxable sale";
      return result(order, line, scenario, why2, why, [sale], {
        notionalItcCents: itc,
        division66Candidate: candidate,
        flags,
        issues,
        unresolved:
          scenario === "A3" && TRADE_IN_TREATMENT === "UNRESOLVED"
            ? "Trade-in treatment (A3) awaits the accountant: split and documents"
            : undefined,
      });
    }

    case "B1":
    case "B2_AGENCY":
    case "C3": {
      if (item.consignor && item.consignor.australianGstRegistered === false && item.consignor.agreementType === "153B") {
        flags.push("Agreement recorded as Subdivision 153-B, but the consignor isn't registered for Australian GST: check with the accountant");
      }
      const commission = item.consignor || item.commissionType ? commissionFor(item, g, line.quantity) : null;
      if (commission === null) {
        return review(order, line, "unknown_commission", "Consigned item has no commission rate", why, flags);
      }
      const payable = g - commission;
      why.push(`commission = ${fmt(commission)} of ${fmt(g)}`);
      if (scenario === "C3" && item.consignor?.australianGstRegistered === true && item.consignor.agreementType === "153B") {
        return result(order, line, "C3", "Consigned (153-B) item exported: LOFI's export sale", why, [exportFree(ACCOUNTS.exportSales, g, "153-B consignment exported")], {
          flags: [...flags, `Consignor's supply to LOFI (${fmt(payable)}) to be recorded as a bill`],
        });
      }
      const reason =
        scenario === "B1"
          ? "Consignment for a non-registered consignor: GST on commission only"
          : scenario === "B2_AGENCY"
            ? "Consignment, registered consignor, agency: consignor reports GST on the sale"
            : "Consigned item exported: proceeds to consignor, GST on commission";
      return result(
        order,
        line,
        scenario,
        reason,
        why,
        [noGst(ACCOUNTS.consignorPayable, payable, "Owed to consignor"), taxable(ACCOUNTS.commissionIncome, commission, "LOFI commission")],
        { flags },
      );
    }

    case "B2_153B": {
      const commission = commissionFor(item, g, line.quantity);
      const payable = commission === null ? null : g - commission;
      return result(order, line, "B2_153B", "Consignment under 153-B: LOFI reports GST on the full sale", why, [taxable(ACCOUNTS.salesStock, g)], {
        flags: [
          ...flags,
          payable === null
            ? "Consignor's supply to LOFI to be recorded as a bill (no commission rate on file)"
            : `Consignor's taxable supply to LOFI to be recorded as a bill: ${fmt(payable)} incl. GST`,
        ],
      });
    }

    case "C1": {
      const extraFlags = [...flags, "Keep export evidence (label, tracking, customs declaration)"];
      const candidate = isDivision66Candidate(item);
      let itc = 0;
      if (candidate) itc = div66Credit(item, 0, extraFlags) ?? 0; // capped at GST on the sale, which is nil
      return result(order, line, "C1", `Exported to ${order.destinationCountry} by LOFI: GST-free`, why, [exportFree(ACCOUNTS.exportSales, g)], {
        notionalItcCents: itc,
        division66Candidate: candidate,
        flags: extraFlags,
      });
    }

    case "C2": {
      if (EBAY_INTERNATIONAL_SHIPPING_TREATMENT === "UNRESOLVED") {
        return result(order, line, "C2", "eBay International Shipping: treatment not yet decided", why, [], {
          flags: [...flags, `Final destination ${order.destinationCountry}`],
          unresolved: "eBay International Shipping treatment (C2) awaits the accountant",
        });
      }
      const p =
        EBAY_INTERNATIONAL_SHIPPING_TREATMENT === "GST_FREE_EXPORT"
          ? exportFree(ACCOUNTS.exportSales, g)
          : taxable(ACCOUNTS.salesStock, g);
      return result(order, line, "C2", "eBay International Shipping", why, [p], { flags });
    }

    case "REVIEW":
      return review(order, line, "manual_review", "Marked for manual review", why, flags);
  }
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
    discountCents: 0,
  };
  const scenarios = new Set(lineResults.map((r) => r.scenario));
  if (lineResults.some((r) => r.approval === "review") || lineResults.length === 0) {
    // The item's own issue already explains why; shipping waits for it.
    return {
      ...base(order, line, "shipping"),
      scenario: "REVIEW",
      approval: "review",
      reason: "Shipping follows the items, and an item on this order needs review",
      explanation: ["shipping follows the items (D2)", "→ needs review with the item"],
      gstCents: 0,
      postings: [],
      notionalItcCents: 0,
      division66Candidate: false,
      flags: [],
      issues: [],
    };
  }
  const flags: string[] = [];
  const issues: Issue[] = [];
  const hasConsignment = [...scenarios].some((s) => s.startsWith("B") || s === "C3");
  if (hasConsignment) {
    const msg = CONSIGNMENT_SHIPPING_BELONGS_TO_LOFI
      ? "Pending sign-off (D2): shipping on a consignment sale treated as LOFI income"
      : "Pending sign-off (D2): shipping on a consignment sale passed to consignor";
    flags.push(msg);
    issues.push({ code: "unsigned_scenario", severity: "signoff", message: msg });
  }
  const exported = [...scenarios].every((s) => s === "C1" || s === "C3" || s === "C2");
  const p = exported
    ? exportFree(ACCOUNTS.shippingIncome, line.grossCents)
    : taxable(ACCOUNTS.shippingIncome, line.grossCents);
  const reason = exported ? "Shipping on an export: GST-free" : "Shipping on a domestic sale: taxable";
  return {
    ...base(order, line, "shipping"),
    scenario: lineResults[0]!.scenario,
    approval: lineResults.some((r) => r.approval !== "approved") || hasConsignment ? "draft" : "approved",
    reason,
    explanation: [`shipping follows the items (D2): ${[...scenarios].join(", ")}`, `→ ${reason}`],
    gstCents: p.gstCents,
    postings: [p],
    notionalItcCents: 0,
    division66Candidate: false,
    flags,
    issues,
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
  const weights = [...order.lines.map((l) => Math.abs(l.grossCents)), Math.abs(order.shippingCents)];
  const parts = allocate(newGross, weights);
  return {
    ...order,
    grossCents: newGross,
    lines: order.lines.map((l, i) => ({ ...l, grossCents: parts[i] ?? 0 })),
    shippingCents: parts[parts.length - 1] ?? 0,
  };
}
