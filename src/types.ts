// Channel-neutral model. eBay and Shopify are converted into these shapes at
// the ingestion layer; everything after that (rules, reconciliation, report)
// never needs to know which marketplace a payout came from.
//
// Naming: NormalisedPayout / OrderSale / SaleLine / Fee / Refund / Adjustment
// are the brief's NormalizedPayout / NormalizedSale / NormalizedSaleLine /
// NormalizedFee / NormalizedRefund / NormalizedAdjustment.

export type Channel = "ebay" | "shopify";

// ---------------------------------------------------------------- provenance

/** Where a normalised record came from on the platform. */
export interface SourceRef {
  platform: Channel;
  payoutId: string;
  /** Platform transaction ID (eBay transactionId, Shopify balance transaction gid). */
  transactionId: string | null;
  /** Platform transaction type as sent, e.g. SALE, NON_SALE_CHARGE, CHARGE. */
  transactionType: string | null;
  orderId: string | null;
  lineItemId: string | null;
  /** The platform's amount exactly as sent, before conversion to cents. */
  rawAmount: string | null;
  rawCurrency: string | null;
  sourceTimestamp: string | null;
}

/** One platform transaction as received, kept for audit and idempotent re-import. */
export interface RawTransaction {
  transactionId: string;
  transactionType: string;
  orderId: string | null;
  rawAmount: string;
  rawCurrency: string;
  sourceTimestamp: string;
  /** The payload, with buyer personal details removed. */
  payload: unknown;
}

export interface RawOrder {
  orderId: string;
  /** Selected order fields only: no names, emails or street addresses. */
  payload: unknown;
}

// ------------------------------------------------------------- payout model

/** How the goods leave LOFI. */
export type ShippingProgram =
  | "domestic"              // shipped within Australia (or local pickup)
  | "direct_export"         // LOFI ships overseas itself (C1)
  | "ebay_international"    // handed to eBay's Australian hub (C2)
  | "unknown";              // no destination available: needs review

export interface SaleLine {
  lineId: string;
  sku: string | null;
  title: string;
  quantity: number;
  /** AUD cents collected for this line, GST-inclusive, after all discounts. */
  grossCents: number;
  /** AUD cents of discount already taken off grossCents (informational). */
  discountCents: number;
  /** Stands in for an order whose details couldn't be fetched; the order-level issue explains it. */
  placeholder?: boolean;
  /** The listing has no SKU; `sku` is the platform listing ID (e.g. EBAY-ITEM-123). */
  skuFromListing?: boolean;
}

export interface OrderSale {
  orderId: string;
  orderName: string;
  orderDate: string;
  /** ISO-2 final destination, or null when the platform didn't say. */
  destinationCountry: string | null;
  /** "staff" when a person recorded the destination because the platform didn't send one. */
  destinationSource?: "platform" | "staff";
  shippingProgram: ShippingProgram;
  /** Currency the buyer paid in, when not AUD (C4). */
  buyerCurrency: string | null;
  /** AUD cents collected for the whole order in this payout. */
  grossCents: number;
  lines: SaleLine[];
  /** AUD cents of shipping charged to the buyer (GST-inclusive). */
  shippingCents: number;
  /** Payment method, e.g. shopify_payments, eBay managed payments. */
  gateway: string;
  /** The platform transaction(s) that collected this money. */
  sources: SourceRef[];
}

export interface Refund {
  orderId: string;
  orderName: string;
  /** Positive cents refunded to the buyer. */
  cents: number;
  date: string;
  /** The original order, so the refund reverses the same scenarios (D3). */
  order: OrderSale | null;
  source: SourceRef;
}

export type FeeCategory = "marketplace" | "payment" | "advertising" | "shipping_label" | "other";

export interface Fee {
  /** Normalised fee type, e.g. ebay_final_value_fee, shopify_payments_fee. */
  type: string;
  category: FeeCategory;
  /** Positive cents = cost to LOFI. Negative = fee credited back. */
  cents: number;
  orderId: string | null;
  description: string;
  source: SourceRef;
}

export interface Adjustment {
  type: string;
  /** Signed cents as they affect the payout (+ adds to it). */
  cents: number;
  orderId: string | null;
  description: string;
  /**
   * false = a transaction type this code doesn't know. It is still counted so
   * the payout total stays honest, but it blocks the payout until reviewed.
   */
  supported: boolean;
  source: SourceRef;
}

export interface NormalisedPayout {
  channel: Channel;
  payoutId: string;
  payoutDate: string;
  /** What actually lands in the bank, AUD cents. */
  netCents: number;
  /** The payout amount exactly as the platform sent it. */
  rawAmount: string;
  rawCurrency: string;
  sales: OrderSale[];
  refunds: Refund[];
  fees: Fee[];
  adjustments: Adjustment[];
  /** Informational notes found while reading the platform data. */
  warnings: string[];
  /** Problems found while reading the platform data that block the payout. */
  issues: Issue[];
  raw: { payout: unknown; transactions: RawTransaction[]; orders: RawOrder[] };
}

// ---------------------------------------------------------------- exceptions

export type IssueCode =
  | "unknown_sku"
  | "unknown_stock_record"
  | "unknown_ownership"
  | "unknown_acquisition_source"
  | "unknown_condition"
  | "unknown_supplier_gst_status"
  | "unknown_consignor"
  | "unknown_consignor_gst_status"
  | "unknown_consignor_agreement"
  | "unknown_commission"
  | "unknown_purchase_price"
  | "unknown_destination"
  | "unresolved_scenario"
  | "manual_review"
  | "unknown_fee_tax"
  | "unsigned_scenario"
  | "fx_policy_pending"
  | "payout_mismatch"
  | "unsupported_transaction_type"
  | "dispute"
  | "order_details_missing"
  | "sale_amount_mismatch"
  | "order_lines_mismatch"
  | "refund_unmatched"
  | "non_aud_transaction"
  | "test_transaction"
  | "transaction_in_other_payout";

/**
 * blocking: a fact is missing or the numbers are wrong. The payout can't be
 *           ready until a person deals with it.
 * signoff:  the accountant hasn't approved this treatment yet. The payout is
 *           provisional, but staff can't fix it themselves.
 */
export type IssueSeverity = "blocking" | "signoff";

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  orderId?: string | null;
  lineId?: string | null;
  sku?: string | null;
  transactionId?: string | null;
  consignorId?: number | null;
  cents?: number;
}

// ---------------------------------------------------------------- stock data

/** "owned" is LOFI-owned stock. */
export type Ownership = "owned" | "consignment";
/** registered_supplier = GST-registered supplier; private_seller = private / non-GST seller. */
export type AcquiredFrom = "registered_supplier" | "private_seller" | "trade_in" | "other";
export type Condition = "new" | "secondhand";

export interface Consignor {
  id: number;
  name: string;
  /** ISO-2 country, null = not recorded. */
  country: string | null;
  /**
   * Registered for *Australian* GST. null = unknown. Registration for VAT/GST
   * in another country is a different fact and is never inferred from this.
   */
  australianGstRegistered: boolean | null;
  /** How australianGstRegistered was set: by a person, or defaulted at intake for an overseas consignor. */
  australianGstBasis: "recorded" | "intake_default_overseas" | null;
  commissionType: "percent" | "fixed";
  /** Percent (25 = 25%) or fixed AUD per unit, as entered. */
  commissionValue: number;
  /** null = not recorded. Never defaulted: it decides B2_AGENCY vs B2_153B. */
  agreementType: "agency" | "153B" | null;
}

/** Facts about one stock item. Tax treatment is derived from these, never stored. */
export interface StockItem {
  sku: string;
  title?: string | null;
  ownership: Ownership;
  acquiredFrom?: AcquiredFrom | null;
  condition?: Condition | null;
  purchaseCents?: number | null;
  consignor?: Consignor | null;
  /** Set when the item names a consignor ID that doesn't exist. */
  consignorMissingId?: number | null;
  commissionType?: "percent" | "fixed" | null;
  commissionValue?: number | null;
  overrideScenario?: ScenarioCode | null;
  /** Where the record came from: its own row, or a SKU prefix default. */
  source: "item" | "prefix";
  /** The prefix that matched, when source = prefix. */
  prefix?: string;
  /** Division 66 record complete (seller name/address/description/date/price). */
  div66RecordComplete?: boolean;
}

// ------------------------------------------------------------ classification

export type ScenarioCode =
  | "A1" | "A2" | "A3"
  | "B1" | "B2_AGENCY" | "B2_153B"
  | "C1" | "C2" | "C3"
  | "REVIEW";

export type TaxCode = "GST" | "GST_FREE_EXPORT" | "NO_GST" | "PENDING";

export interface PostingLine {
  account: string;
  taxCode: TaxCode;
  /** GST-inclusive cents. */
  grossCents: number;
  gstCents: number;
  memo?: string;
}

export interface LineClassification {
  orderId: string;
  orderName: string;
  lineId: string;
  kind: "item" | "shipping";
  sku: string | null;
  title: string;
  scenario: ScenarioCode;
  /** approved = signed off by the accountant; draft = working assumption; review = a person must look. */
  approval: "approved" | "draft" | "review";
  reason: string;
  /** Facts -> conclusion, one step per entry. Answers "why was this classified A2?". */
  explanation: string[];
  grossCents: number;
  discountCents: number;
  gstCents: number;
  postings: PostingLine[];
  /** Division 66 notional credit available on this sale (A2/A3), if any. */
  notionalItcCents: number;
  division66Candidate: boolean;
  flags: string[];
  /** Missing facts and pending sign-offs that apply to this line. */
  issues: Issue[];
  sources: SourceRef[];
}
