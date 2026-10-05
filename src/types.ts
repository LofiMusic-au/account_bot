// Channel-neutral model. eBay and Shopify are converted into these shapes at
// the ingestion layer; everything after that (rules, reconciliation, report)
// never needs to know which marketplace a payout came from.

export type Channel = "ebay" | "shopify";

/** How the goods leave LOFI. */
export type ShippingProgram =
  | "domestic"              // shipped within Australia (or local pickup)
  | "direct_export"         // LOFI ships overseas itself (C1)
  | "ebay_international";   // handed to eBay's Australian hub (C2)

export interface SaleLine {
  lineId: string;
  sku: string | null;
  title: string;
  quantity: number;
  /** AUD cents collected for this line, GST-inclusive, after all discounts. */
  grossCents: number;
}

export interface OrderSale {
  orderId: string;
  orderName: string;
  orderDate: string;
  destinationCountry: string | null;   // ISO-2, final destination
  shippingProgram: ShippingProgram;
  /** Currency the buyer paid in, when not AUD (C4). */
  buyerCurrency: string | null;
  /** AUD cents collected for the whole order in this payout. */
  grossCents: number;
  lines: SaleLine[];
  /** AUD cents of shipping charged to the buyer (GST-inclusive). */
  shippingCents: number;
  /** Payment method, e.g. shopify_payments, Afterpay, eBay managed payments. */
  gateway: string;
}

export interface Refund {
  orderId: string;
  orderName: string;
  /** Positive cents refunded to the buyer. */
  cents: number;
  date: string;
  /** The original order, so the refund reverses the same scenarios (D3). */
  order: OrderSale | null;
}

export interface Fee {
  /** Normalised fee type, e.g. ebay_final_value_fee, shopify_payments_fee. */
  type: string;
  /** Positive cents = cost to LOFI. Negative = fee credited back. */
  cents: number;
  orderId: string | null;
  description: string;
}

export interface Adjustment {
  type: string;
  /** Signed cents as they affect the payout (+ adds to it). */
  cents: number;
  orderId: string | null;
  description: string;
}

export interface NormalisedPayout {
  channel: Channel;
  payoutId: string;
  payoutDate: string;
  /** What actually lands in the bank, AUD cents. */
  netCents: number;
  sales: OrderSale[];
  refunds: Refund[];
  fees: Fee[];
  adjustments: Adjustment[];
  /** Problems found while reading the platform data. */
  warnings: string[];
}

// ---------------------------------------------------------------- stock data

export type Ownership = "owned" | "consignment";
export type AcquiredFrom = "registered_supplier" | "private_seller" | "trade_in";

export interface Consignor {
  id: number;
  name: string;
  gstRegistered: boolean;
  commissionType: "percent" | "fixed";
  commissionValue: number;
  agreementType: "agency" | "153B";
}

export interface StockItem {
  sku: string;
  title?: string | null;
  ownership: Ownership;
  acquiredFrom?: AcquiredFrom | null;
  purchaseCents?: number | null;
  consignor?: Consignor | null;
  commissionType?: "percent" | "fixed" | null;
  commissionValue?: number | null;
  overrideScenario?: ScenarioCode | null;
  /** Where the record came from: its own row, or a SKU prefix default. */
  source: "item" | "prefix";
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
  sku: string | null;
  title: string;
  scenario: ScenarioCode;
  /** approved = signed off by the accountant; draft = working assumption. */
  approval: "approved" | "draft" | "review";
  reason: string;
  grossCents: number;
  gstCents: number;
  postings: PostingLine[];
  /** Division 66 notional credit available on this sale (A2/A3), if any. */
  notionalItcCents: number;
  flags: string[];
}
