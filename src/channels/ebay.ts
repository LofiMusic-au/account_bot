// eBay ingestion: Finances API (payouts and the transactions inside them) and
// Fulfillment API (what was sold, SKU, destination, eBay International Shipping).
//
// Needs an eBay developer app + a user refresh token for LOFI's seller account
// with scopes: sell.finances and sell.fulfillment.readonly.
//
// Field names follow eBay's published types (Transaction, Order, LineItem,
// FulfillmentStartInstruction, Program). Verify against a live payout before
// relying on the numbers; mismatches show up as warnings and an unbalanced
// payout, never as silent errors.

import { toCents } from "../money";
import { rescaleOrder } from "../rules/engine";
import type { Adjustment, Fee, NormalisedPayout, OrderSale, Refund } from "../types";

export interface EbayConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceId: string; // EBAY_AU
  fetch?: typeof fetch;
}

interface Amount {
  value: string;
  currency: string;
  convertedFromCurrency?: string;
  convertedFromValue?: string;
  exchangeRate?: string;
}

export interface EbayPayout {
  payoutId: string;
  payoutStatus: string;
  payoutDate: string;
  amount: Amount;
  transactionCount?: number;
}

export interface EbayTransaction {
  transactionId: string;
  transactionType: string; // SALE, REFUND, CREDIT, DISPUTE, NON_SALE_CHARGE, SHIPPING_LABEL, TRANSFER, ADJUSTMENT, ...
  transactionDate: string;
  bookingEntry: "CREDIT" | "DEBIT";
  amount: Amount;
  orderId?: string;
  payoutId?: string;
  feeType?: string;
  transactionMemo?: string;
  totalFeeAmount?: Amount;
  totalFeeBasisAmount?: Amount;
  eBayCollectedTaxAmount?: Amount;
  orderLineItems?: {
    lineItemId: string;
    feeBasisAmount?: Amount;
    marketplaceFees?: { feeType: string; amount: Amount }[];
  }[];
}

export interface EbayOrder {
  orderId: string;
  creationDate: string;
  salesRecordReference?: string;
  lineItems: {
    lineItemId: string;
    sku?: string;
    title: string;
    quantity: number;
    lineItemCost: Amount;
    discountedLineItemCost?: Amount;
    deliveryCost?: { shippingCost?: Amount };
  }[];
  fulfillmentStartInstructions?: {
    ebaySupportedFulfillment?: boolean;
    finalDestinationAddress?: { countryCode?: string };
    shippingStep?: { shipTo?: { contactAddress?: { countryCode?: string } } };
  }[];
  program?: { ebayInternationalShipping?: unknown };
}

const FINANCES = "https://apiz.ebay.com/sell/finances/v1";
const FULFILLMENT = "https://api.ebay.com/sell/fulfillment/v1";
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.finances",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
].join(" ");

export class EbayClient {
  private token: { value: string; expires: number } | null = null;
  constructor(private cfg: EbayConfig) {}

  private get f() {
    return this.cfg.fetch ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await this.f("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`)}`,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.cfg.refreshToken, scope: SCOPES }),
    });
    if (!res.ok) throw new Error(`eBay token ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async get<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(url, {
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          "X-EBAY-C-MARKETPLACE-ID": this.cfg.marketplaceId,
          Accept: "application/json",
        },
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`eBay ${res.status} ${url}: ${await res.text()}`);
      return (await res.json()) as T;
    }
  }

  async listPayouts(sinceIsoDate: string): Promise<EbayPayout[]> {
    const out: EbayPayout[] = [];
    let url: string | undefined =
      `${FINANCES}/payout?filter=${encodeURIComponent(`payoutDate:[${sinceIsoDate}T00:00:00.000Z..]`)}&limit=200`;
    while (url) {
      const page: { payouts?: EbayPayout[]; next?: string } = await this.get(url);
      out.push(...(page.payouts ?? []));
      url = page.next;
    }
    return out.filter((p) => p.payoutStatus === "SUCCEEDED");
  }

  async payoutTransactions(payoutId: string): Promise<EbayTransaction[]> {
    const out: EbayTransaction[] = [];
    let url: string | undefined =
      `${FINANCES}/transaction?filter=${encodeURIComponent(`payoutId:{${payoutId}}`)}&limit=1000`;
    while (url) {
      const page: { transactions?: EbayTransaction[]; next?: string } = await this.get(url);
      out.push(...(page.transactions ?? []));
      url = page.next;
    }
    return out;
  }

  async order(orderId: string): Promise<EbayOrder | null> {
    try {
      return await this.get<EbayOrder>(`${FULFILLMENT}/order/${encodeURIComponent(orderId)}`);
    } catch {
      return null;
    }
  }

  async fetchPayout(p: EbayPayout): Promise<NormalisedPayout> {
    const txns = await this.payoutTransactions(p.payoutId);
    const ids = [...new Set(txns.map((t) => t.orderId).filter((x): x is string => !!x))];
    const orders = new Map<string, EbayOrder>();
    for (const id of ids) {
      const o = await this.order(id);
      if (o) orders.set(id, o);
    }
    return normaliseEbayPayout(p, txns, orders);
  }
}

const FEE_TYPE_MAP: Record<string, string> = {
  FINAL_VALUE_FEE: "ebay_final_value_fee",
  FINAL_VALUE_FEE_FIXED_PER_ORDER: "ebay_final_value_fee_fixed_per_order",
  INTERNATIONAL_FEE: "ebay_international_fee",
  AD_FEE: "ebay_promoted_listing_fee",
};
const feeType = (t?: string) => (t && FEE_TYPE_MAP[t]) || "ebay_other_fee";

/** eBay order -> channel-neutral order (amounts as sold). */
export function ebayOrderToSale(o: EbayOrder, warnings: string[]): OrderSale {
  const lines = o.lineItems.map((li) => ({
    lineId: li.lineItemId,
    sku: li.sku ?? null,
    title: li.title,
    quantity: li.quantity,
    grossCents: toCents((li.discountedLineItemCost ?? li.lineItemCost).value),
  }));
  const shippingCents = o.lineItems.reduce((a, li) => a + toCents(li.deliveryCost?.shippingCost?.value), 0);
  const fsi = o.fulfillmentStartInstructions?.[0];
  const dest =
    fsi?.finalDestinationAddress?.countryCode ?? fsi?.shippingStep?.shipTo?.contactAddress?.countryCode ?? null;
  const eis = !!o.program?.ebayInternationalShipping || (fsi?.ebaySupportedFulfillment === true && dest !== "AU");
  const buyerCurrency = o.lineItems[0]?.lineItemCost.convertedFromCurrency ?? null;
  if (o.lineItems.some((li) => li.lineItemCost.currency !== "AUD")) {
    warnings.push(`eBay order ${o.orderId}: amounts not in AUD`);
  }
  return {
    orderId: o.orderId,
    orderName: o.salesRecordReference ? `eBay ${o.orderId} (#${o.salesRecordReference})` : `eBay ${o.orderId}`,
    orderDate: o.creationDate,
    destinationCountry: dest,
    shippingProgram: eis ? "ebay_international" : dest && dest !== "AU" ? "direct_export" : "domestic",
    buyerCurrency: buyerCurrency && buyerCurrency !== "AUD" ? buyerCurrency : null,
    grossCents: lines.reduce((a, l) => a + l.grossCents, 0) + shippingCents,
    lines,
    shippingCents,
    gateway: "eBay managed payments",
  };
}

/** Pure: eBay payout + transactions + orders -> NormalisedPayout. */
export function normaliseEbayPayout(
  p: EbayPayout,
  txns: EbayTransaction[],
  orders: Map<string, EbayOrder>,
): NormalisedPayout {
  const warnings: string[] = [];
  const sales: OrderSale[] = [];
  const refunds: Refund[] = [];
  const fees: Fee[] = [];
  const adjustments: Adjustment[] = [];
  const signed = (t: EbayTransaction) => (t.bookingEntry === "CREDIT" ? 1 : -1) * toCents(t.amount.value);

  for (const t of txns) {
    if (t.amount.currency !== "AUD") warnings.push(`eBay transaction ${t.transactionId} is in ${t.amount.currency}`);
    const orderId = t.orderId ?? null;

    switch (t.transactionType) {
      case "SALE": {
        // The sale arrives net of selling fees: gross = net + fees.
        const feeTotal = toCents(t.totalFeeAmount?.value);
        const gross = signed(t) + feeTotal;
        let itemised = 0;
        for (const li of t.orderLineItems ?? []) {
          for (const mf of li.marketplaceFees ?? []) {
            const c = toCents(mf.amount.value);
            itemised += c;
            fees.push({ type: feeType(mf.feeType), cents: c, orderId, description: `${mf.feeType} ${orderId}` });
          }
        }
        if (feeTotal !== itemised) {
          fees.push({ type: "ebay_other_fee", cents: feeTotal - itemised, orderId, description: `Unitemised fees ${orderId}` });
        }
        if (toCents(t.eBayCollectedTaxAmount?.value) !== 0) {
          warnings.push(`eBay order ${orderId}: eBay collected tax on this sale; check the gross`);
        }
        const o = orderId ? orders.get(orderId) : undefined;
        if (!o) {
          warnings.push(`eBay order ${orderId}: order details not found; added for review`);
          sales.push({
            orderId: orderId ?? t.transactionId,
            orderName: `eBay ${orderId ?? t.transactionId}`,
            orderDate: t.transactionDate,
            destinationCountry: null,
            shippingProgram: "domestic",
            buyerCurrency: null,
            grossCents: gross,
            lines: [{ lineId: `${t.transactionId}:unknown`, sku: null, title: "Order details unavailable", quantity: 1, grossCents: gross }],
            shippingCents: 0,
            gateway: "eBay managed payments",
          });
          break;
        }
        let sale = ebayOrderToSale(o, warnings);
        if (sale.grossCents !== gross) {
          warnings.push(`${sale.orderName}: payout shows ${gross} cents, order shows ${sale.grossCents} cents; split in proportion`);
          sale = rescaleOrder(sale, gross);
        }
        sales.push(sale);
        break;
      }
      case "REFUND": {
        const o = orderId ? orders.get(orderId) : undefined;
        refunds.push({
          orderId: orderId ?? t.transactionId,
          orderName: o ? ebayOrderToSale(o, []).orderName : `eBay ${orderId ?? t.transactionId}`,
          cents: -signed(t),
          date: t.transactionDate,
          order: o ? ebayOrderToSale(o, warnings) : null,
        });
        break;
      }
      case "NON_SALE_CHARGE":
        fees.push({ type: feeType(t.feeType), cents: -signed(t), orderId, description: t.transactionMemo ?? t.feeType ?? "eBay charge" });
        break;
      case "SHIPPING_LABEL":
        fees.push({ type: "ebay_shipping_label", cents: -signed(t), orderId, description: t.transactionMemo ?? "Shipping label" });
        break;
      default:
        adjustments.push({
          type: t.transactionType,
          cents: signed(t),
          orderId,
          description: [t.transactionType.toLowerCase(), t.transactionMemo, orderId].filter(Boolean).join(" · "),
        });
    }
  }

  return {
    channel: "ebay",
    payoutId: p.payoutId,
    payoutDate: p.payoutDate.slice(0, 10),
    netCents: toCents(p.amount.value),
    sales,
    refunds,
    fees,
    adjustments,
    warnings,
  };
}
