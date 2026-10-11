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

import { convertAtRate, fmt, toCents } from "../money";
import { rescaleOrder } from "../rules/engine";
import type { Adjustment, Fee, FeeCategory, Issue, NormalisedPayout, OrderSale, RawTransaction, Refund, SourceRef } from "../types";

export interface EbayConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** A ready user access token (for one-off validation runs). Skips the refresh. */
  accessToken?: string;
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

/** Fees on a transaction, in AUD cents, with the evidence used to get there. */
interface FeeLine {
  feeType: string | undefined;
  lineItemId: string | null;
  rawAmount: string;
  rawCurrency: string;
  aud: number;
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
  /** Live API spelling (Oct 2026). */
  ebayCollectedTaxAmount?: Amount;
  /** Spelling in older eBay docs; read too, just in case. */
  eBayCollectedTaxAmount?: Amount;
  orderLineItems?: {
    lineItemId: string;
    feeBasisAmount?: Amount;
    marketplaceFees?: { feeType: string; amount: Amount }[];
  }[];
}

export interface EbayOrder {
  orderId: string;
  pricingSummary?: { total?: Amount; priceSubtotal?: Amount; deliveryCost?: Amount; priceDiscount?: Amount };
  creationDate: string;
  salesRecordReference?: string;
  lineItems: {
    lineItemId: string;
    /** The eBay listing (item) ID. Used as the key when the listing has no SKU. */
    legacyItemId?: string;
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

  /**
   * Call fetch unbound. Cloudflare's runtime throws "Illegal invocation" if
   * fetch is called as a method of another object (e.g. this.f(...)).
   */
  private f(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const doFetch = this.cfg.fetch ?? fetch;
    return doFetch(input, init);
  }

  private async accessToken(): Promise<string> {
    if (this.cfg.accessToken) return this.cfg.accessToken;
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
      if (!res.ok) {
        const body = await res.text();
        // eBay answers some token problems with a 500 in the OAuth domain: retrying won't help.
        const authProblem = /"domain"\s*:\s*"OAuth"/.test(body);
        if ((res.status === 429 || res.status >= 500) && !authProblem && attempt < 4) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        throw new Error(`eBay ${res.status} ${new URL(url).pathname}: ${body.replace(/\s+/g, " ").slice(0, 300)}`);
      }
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

  /** Order details, or the reason they couldn't be fetched (never swallowed). */
  async order(orderId: string): Promise<{ order: EbayOrder } | { error: string }> {
    try {
      return { order: await this.get<EbayOrder>(`${FULFILLMENT}/order/${encodeURIComponent(orderId)}`) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async fetchRaw(p: EbayPayout): Promise<{
    payout: EbayPayout;
    transactions: EbayTransaction[];
    orders: Map<string, EbayOrder>;
    orderErrors: Map<string, string>;
  }> {
    const transactions = await this.payoutTransactions(p.payoutId);
    const ids = [...new Set(transactions.map((t) => t.orderId).filter((x): x is string => !!x))];
    const orders = new Map<string, EbayOrder>();
    const orderErrors = new Map<string, string>();
    for (const id of ids) {
      const r = await this.order(id);
      if ("order" in r) orders.set(id, r.order);
      else orderErrors.set(id, r.error);
    }
    return { payout: p, transactions, orders, orderErrors };
  }

  async fetchPayout(p: EbayPayout): Promise<NormalisedPayout> {
    const raw = await this.fetchRaw(p);
    return normaliseEbayPayout(raw.payout, raw.transactions, raw.orders, raw.orderErrors);
  }
}

const FEE_TYPE_MAP: Record<string, { type: string; category: FeeCategory }> = {
  FINAL_VALUE_FEE: { type: "ebay_final_value_fee", category: "marketplace" },
  FINAL_VALUE_FEE_FIXED_PER_ORDER: { type: "ebay_final_value_fee_fixed_per_order", category: "marketplace" },
  INTERNATIONAL_FEE: { type: "ebay_international_fee", category: "marketplace" },
  AD_FEE: { type: "ebay_promoted_listing_fee", category: "advertising" },
};
const feeType = (t?: string) => (t && FEE_TYPE_MAP[t]) || { type: "ebay_other_fee", category: "other" as const };

/**
 * eBay transaction types handled as adjustments. Others (LOAN_REPAYMENT,
 * PURCHASE, TRANSFER, WITHDRAWAL, anything new) are counted in the total but
 * block the payout as unsupported. DISPUTE is known but always needs a person.
 */
const ADJUSTMENT_TYPES = new Set(["CREDIT", "ADJUSTMENT", "DISPUTE"]);

/** Drop buyer details before a transaction is stored. */
function stripBuyer(t: EbayTransaction): unknown {
  const { buyer: _buyer, ...rest } = t as EbayTransaction & { buyer?: unknown };
  return rest;
}

/**
 * The eBay order fields kept for audit: amounts, SKUs and destination country
 * only. The shape is kept parseable by ebayOrderToSale (fixtures and stored
 * copies normalise the same as live), with names and street addresses dropped.
 */
export function ebayOrderForAudit(o: EbayOrder): EbayOrder {
  return {
    orderId: o.orderId,
    creationDate: o.creationDate,
    salesRecordReference: o.salesRecordReference,
    pricingSummary: o.pricingSummary,
    program: o.program,
    lineItems: o.lineItems.map((li) => ({
      lineItemId: li.lineItemId,
      legacyItemId: li.legacyItemId,
      sku: li.sku,
      title: li.title,
      quantity: li.quantity,
      lineItemCost: li.lineItemCost,
      discountedLineItemCost: li.discountedLineItemCost,
      deliveryCost: li.deliveryCost,
    })),
    fulfillmentStartInstructions: o.fulfillmentStartInstructions?.map((f) => ({
      ebaySupportedFulfillment: f.ebaySupportedFulfillment,
      finalDestinationAddress: f.finalDestinationAddress?.countryCode ? { countryCode: f.finalDestinationAddress.countryCode } : undefined,
      shippingStep: f.shippingStep?.shipTo?.contactAddress?.countryCode
        ? { shipTo: { contactAddress: { countryCode: f.shippingStep.shipTo.contactAddress.countryCode } } }
        : undefined,
    })),
  };
}

/** Key used for an eBay line whose listing has no SKU. */
export const EBAY_LISTING_PREFIX = "EBAY-ITEM-";

/** eBay order -> channel-neutral order (amounts as sold). */
export function ebayOrderToSale(o: EbayOrder, warnings: string[], sources: SourceRef[] = []): OrderSale {
  const lines = o.lineItems.map((li) => {
    const listed = toCents(li.lineItemCost.value);
    const paid = toCents((li.discountedLineItemCost ?? li.lineItemCost).value);
    const sku = li.sku?.trim() || null;
    return {
      lineId: li.lineItemId,
      // No SKU on the listing: key the line on its eBay listing ID instead, so
      // staff can record facts for it like any other SKU.
      sku: sku ?? (li.legacyItemId ? `${EBAY_LISTING_PREFIX}${li.legacyItemId}` : null),
      skuFromListing: !sku && !!li.legacyItemId,
      title: li.title,
      quantity: li.quantity,
      grossCents: paid,
      discountCents: listed - paid,
    };
  });
  const shippingCents = o.lineItems.reduce((a, li) => a + toCents(li.deliveryCost?.shippingCost?.value), 0);
  const fsi = o.fulfillmentStartInstructions?.[0];
  const destRaw =
    fsi?.finalDestinationAddress?.countryCode ?? fsi?.shippingStep?.shipTo?.contactAddress?.countryCode ?? null;
  const dest = destRaw ? destRaw.toUpperCase() : null;
  const eis = !!o.program?.ebayInternationalShipping || (fsi?.ebaySupportedFulfillment === true && dest !== null && dest !== "AU");
  const buyerCurrency = o.lineItems[0]?.lineItemCost.convertedFromCurrency ?? null;
  const currencies = new Set(o.lineItems.flatMap((li) => [li.lineItemCost.currency, li.deliveryCost?.shippingCost?.currency].filter(Boolean)));
  if (currencies.size > 1) warnings.push(`eBay order ${o.orderId}: mixed currencies on one order (${[...currencies].join(", ")})`);
  return {
    orderId: o.orderId,
    orderName: o.salesRecordReference ? `eBay ${o.orderId} (#${o.salesRecordReference})` : `eBay ${o.orderId}`,
    orderDate: o.creationDate,
    destinationCountry: dest,
    shippingProgram: eis ? "ebay_international" : dest === null ? "unknown" : dest !== "AU" ? "direct_export" : "domestic",
    buyerCurrency: buyerCurrency && buyerCurrency !== "AUD" ? buyerCurrency : null,
    grossCents: lines.reduce((a, l) => a + l.grossCents, 0) + shippingCents,
    lines,
    shippingCents,
    gateway: "eBay managed payments",
    sources,
  };
}

/**
 * Fees on a SALE or REFUND converted to AUD.
 *
 * Live LOFI data (Oct 2026): on a sale to an overseas buyer, `amount` is in
 * AUD (converted, with convertedFromCurrency / convertedFromValue /
 * exchangeRate), but totalFeeAmount, totalFeeBasisAmount and every itemised
 * fee are in the buyer's currency. Each foreign fee is converted at eBay's own
 * exchangeRate for that transaction. eBay's AUD net stays authoritative
 * because it is what was paid out; gross = net + converted fees. This is a
 * working method until LOFI's FX policy (C4) is approved.
 */
function feesInAud(
  t: EbayTransaction,
  issue: (msg: string) => void,
): { lines: FeeLine[]; totalAud: number; unitemisedAud: number; currency: string; rate: string | null } {
  const txnCurrency = t.amount.convertedFromCurrency ?? t.amount.currency;
  const rate = t.amount.convertedFromCurrency ? (t.amount.exchangeRate ?? null) : null;
  const toAud = (a: Amount): number => {
    if (a.currency === "AUD") return toCents(a.value);
    if (a.currency !== txnCurrency || !rate) {
      issue(`fee in ${a.currency} but the transaction is in ${txnCurrency}${rate ? "" : " with no exchange rate"}`);
      return 0;
    }
    return convertAtRate(toCents(a.value), rate);
  };
  const lines: FeeLine[] = [];
  for (const li of t.orderLineItems ?? []) {
    for (const mf of li.marketplaceFees ?? []) {
      lines.push({ feeType: mf.feeType, lineItemId: li.lineItemId, rawAmount: mf.amount.value, rawCurrency: mf.amount.currency, aud: toAud(mf.amount) });
    }
  }
  const totalForeign = t.totalFeeAmount ? toCents(t.totalFeeAmount.value) : 0;
  const itemisedForeign = (t.orderLineItems ?? []).flatMap((li) => li.marketplaceFees ?? []).reduce((a, mf) => a + toCents(mf.amount.value), 0);
  const unitemisedForeign = totalForeign - itemisedForeign;
  let unitemisedAud = 0;
  if (unitemisedForeign !== 0 && t.totalFeeAmount) {
    if (t.totalFeeAmount.currency === "AUD") unitemisedAud = unitemisedForeign;
    else if (t.totalFeeAmount.currency === txnCurrency && rate) unitemisedAud = convertAtRate(unitemisedForeign, rate);
    else issue(`fees in ${t.totalFeeAmount.currency} but the transaction is in ${txnCurrency}${rate ? "" : " with no exchange rate"}`);
  }
  const totalAud = lines.reduce((a, l) => a + l.aud, 0) + unitemisedAud;
  return { lines, totalAud, unitemisedAud, currency: txnCurrency, rate };
}

/** Pure: eBay payout + transactions + orders -> NormalisedPayout. */
export function normaliseEbayPayout(
  p: EbayPayout,
  txns: EbayTransaction[],
  orders: Map<string, EbayOrder>,
  orderErrors: Map<string, string> = new Map(),
): NormalisedPayout {
  const warnings: string[] = [];
  const issues: Issue[] = [];
  const sales: OrderSale[] = [];
  const refunds: Refund[] = [];
  const fees: Fee[] = [];
  const adjustments: Adjustment[] = [];
  const raw: RawTransaction[] = [];
  const signed = (t: EbayTransaction) => (t.bookingEntry === "CREDIT" ? 1 : -1) * toCents(t.amount.value);
  const ref = (t: EbayTransaction, extra: Partial<SourceRef> = {}): SourceRef => ({
    platform: "ebay",
    payoutId: p.payoutId,
    transactionId: t.transactionId,
    transactionType: t.transactionType,
    orderId: t.orderId ?? null,
    lineItemId: null,
    rawAmount: t.amount.value,
    rawCurrency: t.amount.currency,
    sourceTimestamp: t.transactionDate,
    ...extra,
  });

  if (p.amount.currency !== "AUD") {
    issues.push({ code: "non_aud_transaction", severity: "blocking", message: `Payout is in ${p.amount.currency}, not AUD` });
  }

  for (const t of txns) {
    raw.push({
      transactionId: t.transactionId,
      transactionType: t.transactionType,
      orderId: t.orderId ?? null,
      rawAmount: t.amount.value,
      rawCurrency: t.amount.currency,
      sourceTimestamp: t.transactionDate,
      payload: stripBuyer(t),
    });
    if (t.amount.currency !== "AUD") {
      issues.push({
        code: "non_aud_transaction",
        severity: "blocking",
        message: `eBay transaction ${t.transactionId} is in ${t.amount.currency}, not AUD`,
        transactionId: t.transactionId,
      });
    }
    const orderId = t.orderId ?? null;
    const src = ref(t);

    switch (t.transactionType) {
      case "SALE": {
        // A SALE arrives net of selling fees, so gross = net + fees. Confirmed
        // on live LOFI payouts (Oct 2026): net + totalFeeAmount equalled
        // totalFeeBasisAmount on every sale. The payout total alone can't
        // prove the gross (it's circular), so it is cross-checked against
        // eBay's fee basis here and against the order below.
        const fx = feesInAud(t, (msg) =>
          issues.push({ code: "non_aud_transaction", severity: "blocking", message: `eBay sale ${t.transactionId}: ${msg}`, transactionId: t.transactionId }),
        );
        const gross = signed(t) + fx.totalAud;
        for (const l of fx.lines) {
          const ft = feeType(l.feeType);
          fees.push({
            type: ft.type,
            category: ft.category,
            cents: l.aud,
            orderId,
            description: `${l.feeType} ${orderId}${l.rawCurrency !== "AUD" ? ` (${l.rawCurrency} ${l.rawAmount} at ${fx.rate})` : ""}`,
            source: ref(t, { lineItemId: l.lineItemId, rawAmount: l.rawAmount, rawCurrency: l.rawCurrency }),
          });
        }
        if (fx.unitemisedAud !== 0) {
          fees.push({
            type: "ebay_other_fee",
            category: "other",
            cents: fx.unitemisedAud,
            orderId,
            description: `Unitemised fees ${orderId}`,
            source: ref(t, { rawAmount: t.totalFeeAmount?.value ?? null, rawCurrency: t.totalFeeAmount?.currency ?? null }),
          });
        }
        if (t.totalFeeBasisAmount) {
          // eBay's fee basis is in the transaction currency: compare like with like.
          const basis = toCents(t.totalFeeBasisAmount.value);
          const netTxn = fx.rate ? toCents(t.amount.convertedFromValue) : signed(t);
          const grossTxn = netTxn + toCents(t.totalFeeAmount?.value);
          if (basis !== grossTxn) {
            warnings.push(
              `eBay sale ${t.transactionId}: net + fees = ${grossTxn} but eBay's fee basis is ${basis} (${t.totalFeeBasisAmount.currency} cents); check the order total`,
            );
          }
          if (fx.rate) {
            const basisAud = convertAtRate(basis, fx.rate);
            if (Math.abs(basisAud - gross) > fx.lines.length + 1) {
              warnings.push(`eBay sale ${t.transactionId}: converted fee basis ${basisAud} cents differs from gross ${gross} cents by more than rounding`);
            }
          }
        }
        if (fx.rate) {
          const msg = `eBay sale ${t.transactionId}: buyer paid in ${fx.currency}; fees converted to AUD at eBay's rate ${fx.rate} (FX policy C4 pending)`;
          warnings.push(msg);
          issues.push({ code: "fx_policy_pending", severity: "signoff", message: msg, transactionId: t.transactionId, orderId });
        }
        const collectedTax = t.ebayCollectedTaxAmount ?? t.eBayCollectedTaxAmount;
        if (collectedTax && toCents(collectedTax.value) !== 0) {
          // e.g. EU VAT (IOSS) or US sales tax: collected and remitted by eBay,
          // not part of eBay's fee basis or of the amount paid out to LOFI.
          warnings.push(
            `eBay sale ${t.transactionId}: eBay collected and remitted ${collectedTax.currency} ${collectedTax.value} tax; it is outside LOFI's gross`,
          );
        }
        const o = orderId ? orders.get(orderId) : undefined;
        if (!o) {
          const why = orderId ? orderErrors.get(orderId) : undefined;
          issues.push({
            code: "order_details_missing",
            severity: "blocking",
            message: `eBay order ${orderId ?? t.transactionId}: order details not available${why ? ` (${why})` : ""}`,
            orderId,
            transactionId: t.transactionId,
          });
          sales.push({
            orderId: orderId ?? t.transactionId,
            orderName: `eBay ${orderId ?? t.transactionId}`,
            orderDate: t.transactionDate,
            destinationCountry: null,
            shippingProgram: "unknown",
            buyerCurrency: fx.rate ? fx.currency : null,
            grossCents: gross,
            lines: [
              { lineId: `${t.transactionId}:unknown`, sku: null, title: "Order details unavailable", quantity: 1, grossCents: gross, discountCents: 0, placeholder: true },
            ],
            shippingCents: 0,
            gateway: "eBay managed payments",
            sources: [src],
          });
          break;
        }
        let sale = ebayOrderToSale(o, [], [src]);
        if (fx.rate && !sale.buyerCurrency) sale = { ...sale, buyerCurrency: fx.currency };
        // Live data: a foreign buyer's order (Fulfillment API) is priced in the
        // buyer's currency, matching the fee basis. Compare in that currency,
        // then split eBay's AUD gross across items and shipping in proportion.
        const orderCurrency = o.lineItems[0]?.lineItemCost.currency ?? "AUD";
        if (orderCurrency !== "AUD") {
          const grossInOrderCurrency =
            fx.rate && orderCurrency === fx.currency ? toCents(t.amount.convertedFromValue) + toCents(t.totalFeeAmount?.value) : null;
          if (grossInOrderCurrency === sale.grossCents) {
            warnings.push(
              `${sale.orderName}: order priced in ${orderCurrency} ${fmt(sale.grossCents).replace("$", "")}; AUD ${fmt(gross)} split across items and shipping in proportion`,
            );
            sale = rescaleOrder(sale, gross);
          } else {
            issues.push({
              code: "sale_amount_mismatch",
              severity: "blocking",
              message: `${sale.orderName}: order total ${sale.grossCents} ${orderCurrency} cents doesn't match the sale (${grossInOrderCurrency ?? "no conversion"} in that currency)`,
              orderId,
              transactionId: t.transactionId,
            });
            sale = rescaleOrder(sale, gross);
          }
        } else if (sale.grossCents !== gross) {
          issues.push({
            code: "sale_amount_mismatch",
            severity: "blocking",
            message: `${sale.orderName}: payout implies ${gross} cents (net + fees) but the order shows ${sale.grossCents} cents; split in proportion until checked`,
            orderId,
            transactionId: t.transactionId,
            cents: gross - sale.grossCents,
          });
          sale = rescaleOrder(sale, gross);
        }
        sales.push(sale);
        break;
      }
      case "REFUND": {
        // A REFUND is booked net of the selling fees eBay credits back, the
        // mirror image of a SALE. Live LOFI payout (Oct 2026): amount 23.46
        // DEBIT + totalFeeAmount 2.44 = totalFeeBasisAmount 25.90. So the buyer
        // was refunded net + fees, and the fees come back as credits.
        const o = orderId ? orders.get(orderId) : undefined;
        const fx = feesInAud(t, (msg) =>
          issues.push({ code: "non_aud_transaction", severity: "blocking", message: `eBay refund ${t.transactionId}: ${msg}`, transactionId: t.transactionId }),
        );
        const refundGross = -signed(t) + fx.totalAud;
        for (const l of fx.lines) {
          const ft = feeType(l.feeType);
          fees.push({
            type: ft.type,
            category: ft.category,
            cents: -l.aud,
            orderId,
            description: `${l.feeType} credited on refund ${orderId ?? t.transactionId}${l.rawCurrency !== "AUD" ? ` (${l.rawCurrency} ${l.rawAmount} at ${fx.rate})` : ""}`,
            source: ref(t, { lineItemId: l.lineItemId, rawAmount: l.rawAmount, rawCurrency: l.rawCurrency }),
          });
        }
        if (fx.unitemisedAud !== 0) {
          fees.push({
            type: "ebay_other_fee",
            category: "other",
            cents: -fx.unitemisedAud,
            orderId,
            description: `Unitemised fee credit on refund ${orderId ?? t.transactionId}`,
            source: ref(t, { rawAmount: t.totalFeeAmount?.value ?? null, rawCurrency: t.totalFeeAmount?.currency ?? null }),
          });
        }
        if (t.totalFeeBasisAmount && !fx.rate && toCents(t.totalFeeBasisAmount.value) !== refundGross) {
          warnings.push(
            `eBay refund ${t.transactionId}: net + fee credit = ${refundGross} cents but eBay's fee basis is ${toCents(t.totalFeeBasisAmount.value)} cents`,
          );
        }
        if (fx.rate) {
          const msg = `eBay refund ${t.transactionId}: in ${fx.currency}; fee credits converted at eBay's rate ${fx.rate} (FX policy C4 pending)`;
          warnings.push(msg);
          issues.push({ code: "fx_policy_pending", severity: "signoff", message: msg, transactionId: t.transactionId, orderId });
        }
        refunds.push({
          orderId: orderId ?? t.transactionId,
          orderName: o ? ebayOrderToSale(o, []).orderName : `eBay ${orderId ?? t.transactionId}`,
          cents: refundGross,
          date: t.transactionDate,
          order: o ? ebayOrderToSale(o, warnings) : null,
          source: src,
        });
        if (!o && orderId) {
          const why = orderErrors.get(orderId);
          warnings.push(`eBay refund ${t.transactionId}: original order ${orderId} not available${why ? " (fetch failed)" : " (not in this payout's orders)"}`);
        }
        break;
      }
      case "NON_SALE_CHARGE": {
        const ft = feeType(t.feeType);
        fees.push({ type: ft.type, category: ft.category, cents: -signed(t), orderId, description: t.transactionMemo ?? t.feeType ?? "eBay charge", source: src });
        break;
      }
      case "SHIPPING_LABEL":
        fees.push({ type: "ebay_shipping_label", category: "shipping_label", cents: -signed(t), orderId, description: t.transactionMemo ?? "Shipping label", source: src });
        break;
      default: {
        const supported = ADJUSTMENT_TYPES.has(t.transactionType);
        if (!supported) {
          issues.push({
            code: "unsupported_transaction_type",
            severity: "blocking",
            message: `eBay transaction type ${t.transactionType} isn't supported yet (${t.transactionId}); counted in the total but needs a person`,
            transactionId: t.transactionId,
            orderId,
            cents: signed(t),
          });
        } else if (t.transactionType === "DISPUTE") {
          issues.push({
            code: "dispute",
            severity: "blocking",
            message: `eBay dispute on ${orderId ?? t.transactionId} affects the sale's GST and needs a person`,
            transactionId: t.transactionId,
            orderId,
            cents: signed(t),
          });
        }
        adjustments.push({
          type: t.transactionType,
          cents: signed(t),
          orderId,
          description: [t.transactionType.toLowerCase(), t.transactionMemo, orderId].filter(Boolean).join(" · "),
          supported,
          source: src,
        });
      }
    }
  }

  return {
    channel: "ebay",
    payoutId: p.payoutId,
    payoutDate: p.payoutDate.slice(0, 10),
    netCents: toCents(p.amount.value),
    rawAmount: p.amount.value,
    rawCurrency: p.amount.currency,
    sales,
    refunds,
    fees,
    adjustments,
    warnings,
    issues,
    raw: {
      payout: p,
      transactions: raw,
      orders: [...orders.values()].map((o) => ({ orderId: o.orderId, payload: ebayOrderForAudit(o) })),
    },
  };
}
