// QuickBooks account and tax-code configuration, by logical key. Business
// logic only ever uses these keys; LOFI's QuickBooks IDs live in the
// qbo_account_map / qbo_tax_code_map tables and are needed only to post.

import type { Channel, FeeCategory, FeeTaxCode } from "../types";
import type { LogicalCategory } from "../accounting/categories";

export type AccountKey =
  | "SALES_DOMESTIC_GST"
  | "SALES_OVERSEAS_NO_GST"
  | "CONSIGNMENT_SALES_NO_GST"
  | "EBAY_FEES"
  | "SHOPIFY_FEES"
  | "PAYPAL_FEES"
  | "AFTERPAY_FEES"
  | "ZIP_FEES"
  | "MARKETPLACE_ADJUSTMENTS"
  | "EBAY_CLEARING"
  | "SHOPIFY_PAYMENTS_CLEARING"
  | "PAYPAL_CLEARING"
  | "AFTERPAY_CLEARING"
  | "ZIP_CLEARING"
  | "BANK";

export type TaxCodeName = "GST (10% Sales)" | "GST free (0% Sales)" | "GST on purchases (10%)" | "GST free purchases (0%)";
export const TAX_CODES: TaxCodeName[] = ["GST (10% Sales)", "GST free (0% Sales)", "GST on purchases (10%)", "GST free purchases (0%)"];
export const taxRateBp = (t: TaxCodeName | null): number => (t === "GST (10% Sales)" || t === "GST on purchases (10%)" ? 1000 : 0);
export const taxAppliesTo = (t: TaxCodeName | null): "Sales" | "Purchase" | null =>
  t === null ? null : t.includes("Sales") ? "Sales" : "Purchase";

export interface AccountDef {
  key: AccountKey;
  name: string;
  type: string;
  detailType: string;
  /** Tax code used on this account's journal lines (null for balance-sheet accounts). */
  taxCode: TaxCodeName | null;
  /** true = LOFI has named this account; false = a placeholder name to confirm. */
  confirmed: boolean;
}

const acct = (key: AccountKey, name: string, type: string, detailType: string, taxCode: TaxCodeName | null, confirmed: boolean): AccountDef => ({
  key,
  name,
  type,
  detailType,
  taxCode,
  confirmed,
});

/** Locked Milestone 2 mappings (Oct 2026). Unconfirmed names are placeholders to agree with LOFI. */
export const ACCOUNT_DEFS: Record<AccountKey, AccountDef> = {
  SALES_DOMESTIC_GST: acct("SALES_DOMESTIC_GST", "Sales", "Income", "Sales of Product Income", "GST (10% Sales)", true),
  SALES_OVERSEAS_NO_GST: acct("SALES_OVERSEAS_NO_GST", "Overseas Sales", "Income", "Sales - retail", "GST free (0% Sales)", true),
  CONSIGNMENT_SALES_NO_GST: acct("CONSIGNMENT_SALES_NO_GST", "Commission Sales", "Income", "Sales - retail", "GST free (0% Sales)", true),
  EBAY_FEES: acct("EBAY_FEES", "eBay Fees", "Expense", "to confirm", "GST free purchases (0%)", false),
  SHOPIFY_FEES: acct("SHOPIFY_FEES", "Shopify Fees", "Expense", "to confirm", "GST on purchases (10%)", false),
  PAYPAL_FEES: acct("PAYPAL_FEES", "PayPal Fees", "Expense", "to confirm", "GST free purchases (0%)", false),
  AFTERPAY_FEES: acct("AFTERPAY_FEES", "Afterpay Fees", "Expense", "to confirm", "GST on purchases (10%)", false),
  ZIP_FEES: acct("ZIP_FEES", "ZIP Fees", "Expense", "to confirm", "GST on purchases (10%)", false),
  MARKETPLACE_ADJUSTMENTS: acct("MARKETPLACE_ADJUSTMENTS", "Marketplace Adjustments", "to confirm", "to confirm", null, false),
  EBAY_CLEARING: acct("EBAY_CLEARING", "eBay Clearing", "Other Current Assets", "to confirm", null, false),
  SHOPIFY_PAYMENTS_CLEARING: acct("SHOPIFY_PAYMENTS_CLEARING", "Shopify Payments Clearing", "Other Current Assets", "to confirm", null, false),
  PAYPAL_CLEARING: acct("PAYPAL_CLEARING", "PayPal Clearing", "Other Current Assets", "to confirm", null, false),
  AFTERPAY_CLEARING: acct("AFTERPAY_CLEARING", "Afterpay Clearing", "Other Current Assets", "to confirm", null, false),
  ZIP_CLEARING: acct("ZIP_CLEARING", "ZIP Clearing", "Other Current Assets", "to confirm", null, false),
  BANK: acct("BANK", "Bank (account payouts land in)", "Bank", "to confirm", null, false),
};

export const CLEARING_FOR: Record<Channel, AccountKey> = { ebay: "EBAY_CLEARING", shopify: "SHOPIFY_PAYMENTS_CLEARING" };

/** Which account a payout-split category posts to. Only classified categories have one. */
export const SALES_ACCOUNT: Partial<Record<LogicalCategory, AccountKey>> = {
  SALES_DOMESTIC_GST: "SALES_DOMESTIC_GST",
  SALES_OVERSEAS_NO_GST: "SALES_OVERSEAS_NO_GST",
  CONSIGNMENT_SALES_NO_GST: "CONSIGNMENT_SALES_NO_GST",
};

/** Fee account by channel (all fee categories on a channel share its account; tax comes from the fee table). */
export const FEE_ACCOUNT: Record<Channel, Record<FeeCategory, AccountKey>> = {
  ebay: { marketplace: "EBAY_FEES", payment: "EBAY_FEES", advertising: "EBAY_FEES", shipping_label: "EBAY_FEES", other: "EBAY_FEES" },
  shopify: { marketplace: "SHOPIFY_FEES", payment: "SHOPIFY_FEES", advertising: "SHOPIFY_FEES", shipping_label: "SHOPIFY_FEES", other: "SHOPIFY_FEES" },
};

export const FEE_TAX_CODE: Record<FeeTaxCode, TaxCodeName> = {
  GST_ON_PURCHASES: "GST on purchases (10%)",
  GST_FREE_PURCHASES: "GST free purchases (0%)",
};
