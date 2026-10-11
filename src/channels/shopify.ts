// Shopify Payments ingestion (Admin GraphQL API).
// Needs a custom app token with read_orders and read_shopify_payments_payouts
// (shown in the GraphQL schema as read_shopify_payments).
//
// Note: only Shopify Payments payouts come through here. Orders paid with
// Afterpay or PayPal settle through those providers instead.

import { allocate, toCents } from "../money";
import { rescaleOrder } from "../rules/engine";
import type { Adjustment, Fee, FeeCategory, Issue, NormalisedPayout, OrderSale, RawTransaction, Refund, SourceRef } from "../types";

export interface ShopifyConfig {
  shop: string; // xxx.myshopify.com
  /** A ready Admin API token (legacy admin-created custom apps, shpat_…). */
  token?: string;
  /**
   * Dev Dashboard app credentials. Exchanged for a 24-hour access token with
   * the client credentials grant (apps used only on stores in LOFI's own
   * organization). Used when `token` isn't set.
   */
  clientId?: string;
  clientSecret?: string;
  apiVersion: string;
  fetch?: typeof fetch;
}

interface Money {
  amount: string;
  currencyCode: string;
}

export interface ShopifyPayout {
  id: string;
  legacyResourceId: string;
  issuedAt: string;
  status: string;
  transactionType: string;
  net: Money;
}

export interface ShopifyBalanceTxn {
  id: string;
  type: string;
  sourceType: string | null;
  test: boolean;
  transactionDate: string;
  adjustmentReason: string | null;
  amount: Money;
  fee: Money;
  net: Money;
  associatedOrder: { id: string; name: string } | null;
}

export interface ShopifyDiscountAllocation {
  allocatedAmountSet: { shopMoney: { amount: string } };
  /** Present from 2026-10 queries; older fixtures may lack it (treated as line-level). */
  discountApplication?: { allocationMethod: string; targetSelection: string; targetType: string } | null;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  presentmentCurrencyCode: string;
  paymentGatewayNames: string[];
  taxesIncluded: boolean;
  shippingAddress: { countryCodeV2: string | null } | null;
  totalShippingPriceSet: { shopMoney: { amount: string } };
  totalPriceSet: { shopMoney: { amount: string }; presentmentMoney?: { amount: string; currencyCode: string } };
  transactions?: {
    kind: string;
    status: string;
    gateway: string | null;
    amountSet: { shopMoney: { amount: string; currencyCode: string }; presentmentMoney: { amount: string; currencyCode: string } };
    settlementCurrency: string | null;
    settlementCurrencyRate: string | null;
  }[];
  /** Delivery methods from fulfillment orders (separate, optional query: needs a fulfillment-orders scope). */
  deliveryMethods?: string[] | null;
  lineItems: {
    nodes: {
      id: string;
      sku: string | null;
      name: string;
      quantity: number;
      originalTotalSet: { shopMoney: { amount: string } };
      discountAllocations: ShopifyDiscountAllocation[];
      taxLines: { priceSet: { shopMoney: { amount: string } } }[];
    }[];
  };
}

// Local pickup is identified from fulfillment orders (Shopify: "don't infer the
// delivery method from shipping lines or the presence of a shipping address").
// Separate query because it needs a fulfillment-orders scope
// (e.g. read_merchant_managed_fulfillment_orders); without it, pickup orders
// fall back to the review queue's destination question.
const DELIVERY_QUERY = `query Delivery($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order { id fulfillmentOrders(first: 10) { nodes { deliveryMethod { methodType } } } }
  }
}`;

const PAYOUTS_QUERY = `query Payouts($q: String!, $after: String) {
  shopifyPaymentsAccount {
    payouts(first: 50, query: $q, after: $after) {
      nodes { id legacyResourceId issuedAt status transactionType net { amount currencyCode } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const TXNS_QUERY = `query PayoutTxns($q: String!, $after: String) {
  shopifyPaymentsAccount {
    balanceTransactions(first: 100, query: $q, after: $after, hideTransfers: true) {
      nodes {
        id type sourceType test transactionDate adjustmentReason
        amount { amount currencyCode }
        fee { amount currencyCode }
        net { amount currencyCode }
        associatedOrder { id name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ORDERS_QUERY = `query Orders($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id name createdAt presentmentCurrencyCode paymentGatewayNames taxesIncluded
      shippingAddress { countryCodeV2 }
      totalShippingPriceSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } presentmentMoney { amount currencyCode } }
      transactions(first: 10) {
        kind status gateway
        amountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        settlementCurrency settlementCurrencyRate
      }
      lineItems(first: 100) {
        nodes {
          id sku name quantity
          originalTotalSet { shopMoney { amount } }
          discountAllocations {
            allocatedAmountSet { shopMoney { amount } }
            discountApplication { allocationMethod targetSelection targetType }
          }
          taxLines { priceSet { shopMoney { amount } } }
        }
      }
    }
  }
}`;

export class ShopifyClient {
  /** Deprecations Shopify reported for our queries (X-Shopify-API-Deprecated-Reason). */
  readonly deprecations = new Set<string>();
  private minted: { value: string; expires: number } | null = null;
  constructor(private cfg: ShopifyConfig) {
    if (!cfg.token && !(cfg.clientId && cfg.clientSecret)) {
      throw new Error("Shopify needs SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET");
    }
  }

  /** The Admin API token: the configured one, or a client-credentials token refreshed before it expires. */
  async accessToken(): Promise<string> {
    if (this.cfg.token) return this.cfg.token;
    if (this.minted && this.minted.expires > Date.now() + 5 * 60_000) return this.minted.value;
    const f = this.cfg.fetch ?? fetch;
    const res = await f(`https://${this.cfg.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.cfg.clientId!, client_secret: this.cfg.clientSecret! }),
    });
    // The response body can echo request details; never include it with the secret in an error.
    if (!res.ok) throw new Error(`Shopify token request ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 200)}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number; scope?: string };
    if (!body.access_token) throw new Error("Shopify token request returned no access_token");
    this.minted = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 86_399) * 1000 };
    return body.access_token;
  }

  async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const f = this.cfg.fetch ?? fetch;
    for (let attempt = 0; ; attempt++) {
      const res = await f(`https://${this.cfg.shop}/admin/api/${this.cfg.apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await this.accessToken() },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
      const deprecated = res.headers.get("X-Shopify-API-Deprecated-Reason");
      if (deprecated) this.deprecations.add(deprecated);
      const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
      if (body.errors?.some((e) => e.extensions?.code === "THROTTLED") && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (body.errors?.length) throw new Error(`Shopify GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
      if (!body.data) throw new Error("Shopify GraphQL: empty response");
      return body.data;
    }
  }

  async listPayouts(sinceIsoDate: string): Promise<ShopifyPayout[]> {
    const out: ShopifyPayout[] = [];
    let after: string | null = null;
    do {
      type R = { shopifyPaymentsAccount: { payouts: { nodes: ShopifyPayout[]; pageInfo: PageInfo } } | null };
      const data: R = await this.gql<R>(PAYOUTS_QUERY, { q: `issued_at:>=${sinceIsoDate}`, after });
      if (!data.shopifyPaymentsAccount) throw new Error("No Shopify Payments account (or the token lacks payouts access)");
      const page = data.shopifyPaymentsAccount.payouts;
      out.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return out.filter((p) => p.transactionType === "DEPOSIT");
  }

  async payoutTransactions(payoutLegacyId: string): Promise<ShopifyBalanceTxn[]> {
    const out: ShopifyBalanceTxn[] = [];
    let after: string | null = null;
    do {
      type R = { shopifyPaymentsAccount: { balanceTransactions: { nodes: ShopifyBalanceTxn[]; pageInfo: PageInfo } } };
      const data: R = await this.gql<R>(TXNS_QUERY, { q: `payments_transfer_id:${payoutLegacyId}`, after });
      const page = data.shopifyPaymentsAccount.balanceTransactions;
      out.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  /** Set when the delivery-method query was refused (missing scope); pickup can't be detected. */
  deliveryMethodsUnavailable: string | null = null;

  async orders(ids: string[]): Promise<Map<string, ShopifyOrder>> {
    const map = new Map<string, ShopifyOrder>();
    for (let i = 0; i < ids.length; i += 50) {
      const data = await this.gql<{ nodes: (ShopifyOrder | null)[] }>(ORDERS_QUERY, { ids: ids.slice(i, i + 50) });
      for (const o of data.nodes) if (o) map.set(o.id, o);
    }
    if (!this.deliveryMethodsUnavailable) {
      try {
        for (let i = 0; i < ids.length; i += 50) {
          type R = { nodes: ({ id: string; fulfillmentOrders: { nodes: { deliveryMethod: { methodType: string } | null }[] } } | null)[] };
          const data = await this.gql<R>(DELIVERY_QUERY, { ids: ids.slice(i, i + 50) });
          for (const n of data.nodes) {
            const o = n ? map.get(n.id) : undefined;
            if (o && n) o.deliveryMethods = n.fulfillmentOrders.nodes.map((f) => f.deliveryMethod?.methodType ?? "NONE");
          }
        }
      } catch (e) {
        this.deliveryMethodsUnavailable = (e as Error).message.split(";")[0]!.slice(0, 200);
      }
    }
    return map;
  }

  async fetchRaw(p: ShopifyPayout): Promise<{
    payout: ShopifyPayout;
    transactions: ShopifyBalanceTxn[];
    orders: Map<string, ShopifyOrder>;
    orderErrors: Map<string, string>;
  }> {
    const transactions = await this.payoutTransactions(p.legacyResourceId);
    const orderIds = [...new Set(transactions.map((t) => t.associatedOrder?.id).filter((x): x is string => !!x))];
    // Order details failing (e.g. a missing read_orders scope) mustn't stop the
    // payout being reconciled; each affected sale is held with the reason.
    try {
      return { payout: p, transactions, orders: await this.orders(orderIds), orderErrors: new Map() };
    } catch (e) {
      const msg = (e as Error).message.split(";")[0]!.slice(0, 300);
      return { payout: p, transactions, orders: new Map(), orderErrors: new Map(orderIds.map((id) => [id, msg])) };
    }
  }

  async fetchPayout(p: ShopifyPayout): Promise<NormalisedPayout> {
    const raw = await this.fetchRaw(p);
    const payout = normaliseShopifyPayout(raw.payout, raw.transactions, raw.orders, raw.orderErrors);
    for (const d of this.deprecations) payout.warnings.push(`Shopify API ${this.cfg.apiVersion} reports a deprecation used by this app: ${d}`);
    return payout;
  }
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shopify Payments balance transaction types this code understands, from the
 * ShopifyPaymentsTransactionType enum (checked for API 2026-10). 2026-10 added
 * CURRENCY_CONVERSION; it is deliberately left unsupported (blocking) until a
 * live example shows how it should be read. Anything else is
 * counted in the total but blocks the payout as unsupported.
 */
const FEE_TYPES: Record<string, { type: string; category: FeeCategory }> = {
  CHARGEBACK_FEE: { type: "shopify_chargeback_fee", category: "payment" },
  CHARGEBACK_FEE_REFUND: { type: "shopify_chargeback_fee", category: "payment" },
};
const ADJUSTMENT_TYPES = new Set([
  "ADJUSTMENT",
  "CHARGE_ADJUSTMENT",
  "REFUND_ADJUSTMENT",
  "REFUND_FAILURE",
  "RESERVED_FUNDS",
  "RESERVED_FUNDS_WITHDRAWAL",
  "RESERVED_FUNDS_REVERSAL",
  "CHARGEBACK_HOLD",
  "CHARGEBACK_HOLD_RELEASE",
]);
const DISPUTE_TYPES = new Set(["DISPUTE_WITHDRAWAL", "DISPUTE_REVERSAL"]);

function ref(p: ShopifyPayout, t: ShopifyBalanceTxn | null, extra: Partial<SourceRef> = {}): SourceRef {
  return {
    platform: "shopify",
    payoutId: p.legacyResourceId,
    transactionId: t?.id ?? null,
    transactionType: t?.type ?? null,
    orderId: t?.associatedOrder?.id ?? null,
    lineItemId: null,
    rawAmount: t?.amount.amount ?? null,
    rawCurrency: t?.amount.currencyCode ?? null,
    sourceTimestamp: t?.transactionDate ?? null,
    ...extra,
  };
}

/** An order-level discount (applies across all items), as opposed to one on a particular line. */
const isOrderLevel = (d: ShopifyDiscountAllocation) =>
  d.discountApplication?.targetType === "LINE_ITEM" &&
  d.discountApplication.targetSelection === "ALL" &&
  d.discountApplication.allocationMethod === "ACROSS";

/**
 * Shopify order -> channel-neutral order (full amounts, as sold).
 *
 * Discounts (locked rule): an order-level discount is split EVENLY across the
 * order's item lines, not in proportion to price (Shopify allocates it
 * proportionally; that allocation is replaced). Line-level discounts stay on
 * their line. Local pickup (fulfillment order PICK_UP) is a domestic sale.
 */
export function shopifyOrderToSale(o: ShopifyOrder, warnings: string[], sources: SourceRef[] = []): OrderSale {
  const nodes = o.lineItems.nodes;
  const orderLevel = nodes.reduce(
    (a, li) => a + li.discountAllocations.filter(isOrderLevel).reduce((b, d) => b + toCents(d.allocatedAmountSet.shopMoney.amount), 0),
    0,
  );
  const evenShares = allocate(orderLevel, nodes.map(() => 1));
  const lines = nodes.map((li, i) => {
    const original = toCents(li.originalTotalSet.shopMoney.amount);
    const lineLevel = li.discountAllocations.filter((d) => !isOrderLevel(d)).reduce((a, d) => a + toCents(d.allocatedAmountSet.shopMoney.amount), 0);
    const discounts = lineLevel + (evenShares[i] ?? 0);
    const tax = o.taxesIncluded ? 0 : li.taxLines.reduce((a, t) => a + toCents(t.priceSet.shopMoney.amount), 0);
    return {
      lineId: li.id,
      sku: li.sku?.trim() || null,
      skuFromListing: false,
      title: li.name,
      quantity: li.quantity,
      grossCents: original - discounts + tax,
      discountCents: discounts,
    };
  });
  if (orderLevel) warnings.push(`${o.name}: order-level discount ${(orderLevel / 100).toFixed(2)} split evenly across ${nodes.length} item(s)`);
  const shippingCents = toCents(o.totalShippingPriceSet.shopMoney.amount);
  const grossCents = lines.reduce((a, l) => a + l.grossCents, 0) + shippingCents;
  const total = toCents(o.totalPriceSet.shopMoney.amount);
  if (total !== grossCents) {
    warnings.push(`${o.name}: lines + shipping = ${grossCents} cents but Shopify total is ${total} cents`);
  }
  const pickup = !!o.deliveryMethods?.length && o.deliveryMethods.every((m) => m === "PICK_UP");
  const addr = o.shippingAddress?.countryCodeV2?.toUpperCase() ?? null;
  const dest = addr ?? (pickup ? "AU" : null);
  const presentment = o.totalPriceSet.presentmentMoney;
  const settled = o.transactions?.find((t) => t.status === "SUCCESS" && (t.kind === "SALE" || t.kind === "CAPTURE"));
  const fx =
    presentment && presentment.currencyCode !== "AUD"
      ? {
          currency: presentment.currencyCode,
          foreignAmount: presentment.amount,
          rate: settled?.settlementCurrencyRate ?? null,
          audCents: total,
          source: "shopify_presentment_settlement" as const,
        }
      : null;
  return {
    orderId: o.id,
    orderName: o.name,
    orderDate: o.createdAt,
    destinationCountry: dest,
    deliveryMethod: pickup && !addr ? "pickup" : "shipping",
    shippingProgram: dest === null ? "unknown" : dest !== "AU" ? "direct_export" : "domestic",
    buyerCurrency: o.presentmentCurrencyCode !== "AUD" ? o.presentmentCurrencyCode : null,
    fx,
    grossCents,
    lines,
    shippingCents,
    gateway: o.paymentGatewayNames.join(", "),
    sources,
  };
}

/** The order fields kept for audit. The query asks for no names or street addresses. */
const orderForAudit = (o: ShopifyOrder) => o;

/** Pure: Shopify payout + its balance transactions + orders -> NormalisedPayout. */
export function normaliseShopifyPayout(
  p: ShopifyPayout,
  txns: ShopifyBalanceTxn[],
  orders: Map<string, ShopifyOrder>,
  orderErrors: Map<string, string> = new Map(),
): NormalisedPayout {
  const warnings: string[] = [];
  const issues: Issue[] = [];
  const fees: Fee[] = [];
  const refunds: Refund[] = [];
  const adjustments: Adjustment[] = [];
  const raw: RawTransaction[] = [];
  const chargesByOrder = new Map<string, { name: string; cents: number; date: string; sources: SourceRef[] }>();
  if (p.net.currencyCode !== "AUD") {
    issues.push({ code: "non_aud_transaction", severity: "blocking", message: `Payout is in ${p.net.currencyCode}, not AUD` });
  }

  for (const t of txns) {
    raw.push({
      transactionId: t.id,
      transactionType: t.type,
      orderId: t.associatedOrder?.id ?? null,
      rawAmount: t.amount.amount,
      rawCurrency: t.amount.currencyCode,
      sourceTimestamp: t.transactionDate,
      payload: t,
    });
    const src = ref(p, t);
    if (t.test) {
      issues.push({ code: "test_transaction", severity: "blocking", message: `Test transaction ${t.id} is in this payout`, transactionId: t.id });
    }
    if (t.amount.currencyCode !== "AUD") {
      issues.push({
        code: "non_aud_transaction",
        severity: "blocking",
        message: `Transaction ${t.id} is in ${t.amount.currencyCode}, not AUD`,
        transactionId: t.id,
      });
    }
    const amount = toCents(t.amount.amount);
    const fee = toCents(t.fee.amount);
    const net = toCents(t.net.amount);
    if (amount - fee !== net) {
      issues.push({
        code: "payout_mismatch",
        severity: "blocking",
        message: `Transaction ${t.id}: amount ${t.amount.amount} less fee ${t.fee.amount} isn't net ${t.net.amount}`,
        transactionId: t.id,
        cents: net - (amount - fee),
      });
    }
    const orderId = t.associatedOrder?.id ?? null;
    const orderName = t.associatedOrder?.name ?? "(no order)";
    const feeSrc = ref(p, t, { rawAmount: t.fee.amount, rawCurrency: t.fee.currencyCode });

    if (t.type === "CHARGE" && orderId) {
      const c = chargesByOrder.get(orderId) ?? { name: orderName, cents: 0, date: t.transactionDate, sources: [] };
      c.cents += amount;
      c.sources.push(src);
      chargesByOrder.set(orderId, c);
      if (fee) fees.push({ type: "shopify_payments_fee", category: "payment", cents: fee, orderId, description: `Payment processing ${orderName}`, source: feeSrc });
    } else if (t.type === "REFUND" && orderId) {
      const o = orders.get(orderId);
      if (!o) {
        const why = orderErrors.get(orderId);
        issues.push({
          code: "order_details_missing",
          severity: "blocking",
          message: `${orderName}: refunded order not available${why ? ` (${why})` : ""}`,
          orderId,
          transactionId: t.id,
        });
      }
      refunds.push({
        orderId,
        orderName,
        cents: -amount,
        date: t.transactionDate,
        order: o ? shopifyOrderToSale(o, warnings) : null,
        source: src,
      });
      if (fee) fees.push({ type: "shopify_payments_fee", category: "payment", cents: fee, orderId, description: `Refund fee ${orderName}`, source: feeSrc });
    } else if (t.type.startsWith("SHIPPING_")) {
      fees.push({ type: "shopify_shipping_label", category: "shipping_label", cents: -net, orderId, description: t.type.toLowerCase(), source: src });
    } else if (FEE_TYPES[t.type]) {
      const f = FEE_TYPES[t.type]!;
      fees.push({ type: f.type, category: f.category, cents: -net, orderId, description: t.type.toLowerCase(), source: src });
    } else {
      const supported = ADJUSTMENT_TYPES.has(t.type) || DISPUTE_TYPES.has(t.type);
      if (!supported) {
        issues.push({
          code: "unsupported_transaction_type",
          severity: "blocking",
          message: `Shopify transaction type ${t.type} isn't supported yet (${t.id}); counted in the total but needs a person`,
          transactionId: t.id,
          orderId,
          cents: net,
        });
      } else if (DISPUTE_TYPES.has(t.type)) {
        issues.push({
          code: "dispute",
          severity: "blocking",
          message: `${orderName}: ${t.type.toLowerCase()} (chargeback) affects the sale's GST and needs a person`,
          transactionId: t.id,
          orderId,
          cents: net,
        });
      }
      adjustments.push({
        type: t.type,
        cents: net,
        orderId,
        description: [t.type.toLowerCase(), t.adjustmentReason, t.associatedOrder?.name].filter(Boolean).join(" · "),
        supported,
        source: src,
      });
    }
  }

  const sales: OrderSale[] = [];
  for (const [orderId, charge] of chargesByOrder) {
    const o = orders.get(orderId);
    if (!o) {
      const why = orderErrors.get(orderId);
      issues.push({
        code: "order_details_missing",
        severity: "blocking",
        message: `${charge.name}: order details not available${why ? ` (${why})` : ""}`,
        orderId,
      });
      sales.push({
        orderId,
        orderName: charge.name,
        orderDate: charge.date,
        destinationCountry: null,
        shippingProgram: "unknown",
        deliveryMethod: "shipping",
        buyerCurrency: null,
        fx: null,
        grossCents: charge.cents,
        lines: [
          { lineId: `${orderId}:unknown`, sku: null, title: "Order details unavailable", quantity: 1, grossCents: charge.cents, discountCents: 0, placeholder: true },
        ],
        shippingCents: 0,
        gateway: "shopify_payments",
        sources: charge.sources,
      });
      continue;
    }
    let sale = shopifyOrderToSale(o, warnings, charge.sources);
    if (sale.grossCents !== charge.cents) {
      warnings.push(
        `${o.name}: Shopify Payments collected ${charge.cents} cents of a ${sale.grossCents} cent order (part-paid another way?); split in proportion`,
      );
      sale = rescaleOrder(sale, charge.cents);
    }
    sales.push(sale);
  }

  return {
    channel: "shopify",
    payoutId: p.legacyResourceId,
    payoutDate: p.issuedAt.slice(0, 10),
    netCents: toCents(p.net.amount),
    rawAmount: p.net.amount,
    rawCurrency: p.net.currencyCode,
    sales,
    refunds,
    fees,
    adjustments,
    warnings,
    issues,
    raw: {
      payout: p,
      transactions: raw,
      orders: [...orders.values()].map((o) => ({ orderId: o.id, payload: orderForAudit(o) })),
    },
  };
}
