// LOFI's GST scenarios, as set out in "LOFI GST & Accounting Scenarios —
// for accountant sign-off". Every scenario starts as signedOff: false.
// When the accountant approves one, flip it to true (and record who/when).
// Nothing is ever posted to QuickBooks from a scenario that isn't signed off.

import type { FeeTaxCode, ScenarioCode, TaxCode } from "../types";

export interface ScenarioDef {
  code: ScenarioCode;
  name: string;
  signedOff: boolean;
  signedOffBy?: string;
  signedOffOn?: string;
  /** Open question from the sign-off doc, shown on the report. */
  pending?: string;
}

export const SCENARIOS: Record<ScenarioCode, ScenarioDef> = {
  A1: { code: "A1", name: "Owned stock from GST-registered supplier, sold in Australia", signedOff: false },
  A2: {
    code: "A2",
    name: "Second-hand item bought from a private seller, sold in Australia",
    signedOff: false,
    pending: "Division 66 eligibility, timing, records and QuickBooks posting",
  },
  A3: {
    code: "A3",
    name: "Trade-in item, resold",
    signedOff: false,
    pending: "Trade-in split and documents",
  },
  B1: {
    code: "B1",
    name: "Consignment, consignor not GST-registered (LOFI as agent)",
    signedOff: false,
    pending: "Agency status under LOFI's actual consignment agreement",
  },
  B2_AGENCY: {
    code: "B2_AGENCY",
    name: "Consignment, GST-registered consignor, ordinary agency",
    signedOff: false,
    pending: "Agency or Subdivision 153-B",
  },
  B2_153B: {
    code: "B2_153B",
    name: "Consignment, GST-registered consignor, Subdivision 153-B",
    signedOff: false,
    pending: "Agency or Subdivision 153-B",
  },
  C1: {
    code: "C1",
    name: "LOFI ships overseas itself (GST-free export)",
    signedOff: false,
    pending: "Export evidence requirements",
  },
  C2: {
    code: "C2",
    name: "Overseas sale through eBay International Shipping",
    signedOff: false,
    pending: "GST-free or taxable for LOFI — build blocker",
  },
  C3: {
    code: "C3",
    name: "Consigned item sold overseas",
    signedOff: false,
  },
  REVIEW: { code: "REVIEW", name: "Needs a person to classify", signedOff: false },
};

/**
 * C2: eBay International Shipping sales are overseas, GST-free. Confirmed as
 * LOFI's accounting rule (Milestone 2 brief, Oct 2026).
 */
export const EBAY_INTERNATIONAL_SHIPPING_TREATMENT: TaxCode | "UNRESOLVED" = "GST_FREE_EXPORT";

/**
 * A3 (trade-ins) is deliberately deferred. Trade-in sales are marked
 * "deferred" (kept, never blocking) rather than resolved. Set to "RESOLVED"
 * once a trade-in workflow is approved.
 */
export const TRADE_IN_TREATMENT: "RESOLVED" | "UNRESOLVED" = "UNRESOLVED";

/** Division 66: purchases above this are credited in the period of resale. */
export const DIV66_THRESHOLD_CENTS = 300_00;

/** QuickBooks account names (proposed; match to LOFI's chart of accounts). */
export const ACCOUNTS = {
  salesStock: "Sales – Stock",
  exportSales: "Export Sales",
  commissionIncome: "Consignment Commission Income",
  consignorPayable: "Consignor Payable",
  shippingIncome: "Shipping Income",
  marketplaceFees: "Marketplace Fees",
  fxGainLoss: "FX Gain/Loss",
  clearing: {
    ebay: "eBay Clearing",
    shopify: "Shopify Payments Clearing",
  },
} as const;

/**
 * D1 (locked rule, Oct 2026): GST on platform/merchant fees.
 *   eBay, PayPal               -> GST free purchases (0%)
 *   Shopify, Afterpay, ZIP     -> GST on purchases (10%)
 * Configured per fee type. A fee type not listed here blocks the payout
 * until it is added; nothing is inferred.
 */
export const FEE_TAX: Record<string, FeeTaxCode> = {
  ebay_final_value_fee: "GST_FREE_PURCHASES",
  ebay_final_value_fee_fixed_per_order: "GST_FREE_PURCHASES",
  ebay_promoted_listing_fee: "GST_FREE_PURCHASES",
  ebay_international_fee: "GST_FREE_PURCHASES",
  ebay_shipping_label: "GST_FREE_PURCHASES",
  ebay_other_fee: "GST_FREE_PURCHASES",
  shopify_payments_fee: "GST_ON_PURCHASES",
  shopify_shipping_label: "GST_ON_PURCHASES",
  shopify_chargeback_fee: "GST_ON_PURCHASES",
  // Channels not ingested yet; the rule is fixed for when they are.
  paypal_fee: "GST_FREE_PURCHASES",
  afterpay_fee: "GST_ON_PURCHASES",
  zip_fee: "GST_ON_PURCHASES",
};

/**
 * D2: on a consignment sale, does shipping income belong to LOFI (taxable)?
 * Working assumption: yes. Shown as draft until signed off.
 */
export const CONSIGNMENT_SHIPPING_BELONGS_TO_LOFI = true;
