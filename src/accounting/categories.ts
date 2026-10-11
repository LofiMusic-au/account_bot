// Logical accounting categories. The payout split and the consignment
// subledger are expressed in these, never in QuickBooks account IDs, so the
// posting layer (milestone 2) can map them later and accounting recipes can
// change without rebuilding source data.

export type LogicalCategory =
  | "SALES_DOMESTIC_GST"
  | "SALES_OVERSEAS_NO_GST"
  | "CONSIGNMENT_SALES_NO_GST"
  | "EBAY_FEES"
  | "SHOPIFY_FEES"
  | "MARKETPLACE_ADJUSTMENTS"
  | "REFUND"
  | "UNCLASSIFIED";

export interface CategoryDef {
  code: LogicalCategory;
  label: string;
  /** The QuickBooks account staff historically used, as described by LOFI. Not an ID. */
  historicalAccount: string | null;
  /** Filled in milestone 2 from LOFI's chart of accounts. */
  qboAccountId: string | null;
}

export const CATEGORIES: Record<LogicalCategory, CategoryDef> = {
  SALES_DOMESTIC_GST: { code: "SALES_DOMESTIC_GST", label: "LOFI-owned sale in Australia", historicalAccount: "Sales - GST", qboAccountId: null },
  SALES_OVERSEAS_NO_GST: { code: "SALES_OVERSEAS_NO_GST", label: "LOFI-owned sale overseas", historicalAccount: "Overseas Sales - No GST", qboAccountId: null },
  CONSIGNMENT_SALES_NO_GST: {
    code: "CONSIGNMENT_SALES_NO_GST",
    label: "Consignment sale (full amount, no GST; commission handled in the consignment ledger)",
    historicalAccount: "Consignment sales - No GST",
    qboAccountId: null,
  },
  EBAY_FEES: { code: "EBAY_FEES", label: "eBay fees", historicalAccount: "eBay Fees - No GST", qboAccountId: null },
  SHOPIFY_FEES: { code: "SHOPIFY_FEES", label: "Shopify Payments fees", historicalAccount: null, qboAccountId: null },
  MARKETPLACE_ADJUSTMENTS: { code: "MARKETPLACE_ADJUSTMENTS", label: "Marketplace adjustments and credits", historicalAccount: null, qboAccountId: null },
  REFUND: { code: "REFUND", label: "Refund (reverses the original sale's category)", historicalAccount: null, qboAccountId: null },
  UNCLASSIFIED: { code: "UNCLASSIFIED", label: "Not classified yet (missing facts or unsupported)", historicalAccount: null, qboAccountId: null },
};

/**
 * Which accounting recipe produced a split. The historical baseline is LOFI's
 * current operational treatment, captured so the system reproduces what staff
 * do today. It is NOT an accountant-approved treatment; the signed-off GST
 * scenarios (src/rules) remain authoritative for any change.
 */
export const HISTORICAL_BASELINE = {
  id: "historical_baseline_v1",
  label: "Historical baseline (LOFI's current manual method, not accountant-approved)",
} as const;
