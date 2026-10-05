// Shopify Payments ingestion (Admin GraphQL API).
// Needs a custom app token with read_orders and read_shopify_payments_payouts
// (shown in the GraphQL schema as read_shopify_payments).
//
// Note: only Shopify Payments payouts come through here. Orders paid with
// Afterpay or PayPal settle through those providers instead.

import { toCents } from "../money";
import { rescaleOrder } from "../rules/engine";
import type { Adjustment, Fee, NormalisedPayout, OrderSale, Refund } from "../types";

export interface ShopifyConfig {
  shop: string; // xxx.myshopify.com
  token: string;
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

export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  presentmentCurrencyCode: string;
  paymentGatewayNames: string[];
  taxesIncluded: boolean;
  shippingAddress: { countryCodeV2: string | null } | null;
  totalShippingPriceSet: { shopMoney: { amount: string } };
  totalPriceSet: { shopMoney: { amount: string } };
  lineItems: {
    nodes: {
      id: string;
      sku: string | null;
      name: string;
      quantity: number;
      originalTotalSet: { shopMoney: { amount: string } };
      discountAllocations: { allocatedAmountSet: { shopMoney: { amount: string } } }[];
      taxLines: { priceSet: { shopMoney: { amount: string } } }[];
    }[];
  };
}

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
      totalPriceSet { shopMoney { amount } }
      lineItems(first: 100) {
        nodes {
          id sku name quantity
          originalTotalSet { shopMoney { amount } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } } }
          taxLines { priceSet { shopMoney { amount } } }
        }
      }
    }
  }
}`;

export class ShopifyClient {
  constructor(private cfg: ShopifyConfig) {}

  async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const f = this.cfg.fetch ?? fetch;
    for (let attempt = 0; ; attempt++) {
      const res = await f(`https://${this.cfg.shop}/admin/api/${this.cfg.apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.cfg.token },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
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

  async orders(ids: string[]): Promise<Map<string, ShopifyOrder>> {
    const map = new Map<string, ShopifyOrder>();
    for (let i = 0; i < ids.length; i += 50) {
      const data = await this.gql<{ nodes: (ShopifyOrder | null)[] }>(ORDERS_QUERY, { ids: ids.slice(i, i + 50) });
      for (const o of data.nodes) if (o) map.set(o.id, o);
    }
    return map;
  }

  async fetchPayout(p: ShopifyPayout): Promise<NormalisedPayout> {
    const txns = await this.payoutTransactions(p.legacyResourceId);
    const orderIds = [...new Set(txns.map((t) => t.associatedOrder?.id).filter((x): x is string => !!x))];
    const orders = await this.orders(orderIds);
    return normaliseShopifyPayout(p, txns, orders);
  }
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shopify order -> channel-neutral order (full amounts, as sold). */
export function shopifyOrderToSale(o: ShopifyOrder, warnings: string[]): OrderSale {
  const lines = o.lineItems.nodes.map((li) => {
    const original = toCents(li.originalTotalSet.shopMoney.amount);
    const discounts = li.discountAllocations.reduce((a, d) => a + toCents(d.allocatedAmountSet.shopMoney.amount), 0);
    const tax = o.taxesIncluded ? 0 : li.taxLines.reduce((a, t) => a + toCents(t.priceSet.shopMoney.amount), 0);
    return { lineId: li.id, sku: li.sku, title: li.name, quantity: li.quantity, grossCents: original - discounts + tax };
  });
  const shippingCents = toCents(o.totalShippingPriceSet.shopMoney.amount);
  const grossCents = lines.reduce((a, l) => a + l.grossCents, 0) + shippingCents;
  const total = toCents(o.totalPriceSet.shopMoney.amount);
  if (total !== grossCents) {
    warnings.push(`${o.name}: lines + shipping = ${grossCents} cents but Shopify total is ${total} cents`);
  }
  const dest = o.shippingAddress?.countryCodeV2 ?? null;
  return {
    orderId: o.id,
    orderName: o.name,
    orderDate: o.createdAt,
    destinationCountry: dest,
    shippingProgram: dest && dest !== "AU" ? "direct_export" : "domestic",
    buyerCurrency: o.presentmentCurrencyCode !== "AUD" ? o.presentmentCurrencyCode : null,
    grossCents,
    lines,
    shippingCents,
    gateway: o.paymentGatewayNames.join(", "),
  };
}

/** Pure: Shopify payout + its balance transactions + orders -> NormalisedPayout. */
export function normaliseShopifyPayout(
  p: ShopifyPayout,
  txns: ShopifyBalanceTxn[],
  orders: Map<string, ShopifyOrder>,
): NormalisedPayout {
  const warnings: string[] = [];
  const fees: Fee[] = [];
  const refunds: Refund[] = [];
  const adjustments: Adjustment[] = [];
  const chargesByOrder = new Map<string, { name: string; cents: number; date: string }>();

  for (const t of txns) {
    if (t.test) {
      warnings.push(`Test transaction ${t.id} included in payout`);
    }
    if (t.amount.currencyCode !== "AUD") warnings.push(`Transaction ${t.id} is in ${t.amount.currencyCode}`);
    const amount = toCents(t.amount.amount);
    const fee = toCents(t.fee.amount);
    const net = toCents(t.net.amount);
    const orderId = t.associatedOrder?.id ?? null;
    const orderName = t.associatedOrder?.name ?? "(no order)";

    if (t.type === "CHARGE" && orderId) {
      const c = chargesByOrder.get(orderId) ?? { name: orderName, cents: 0, date: t.transactionDate };
      c.cents += amount;
      chargesByOrder.set(orderId, c);
      if (fee) fees.push({ type: "shopify_payments_fee", cents: fee, orderId, description: `Payment processing ${orderName}` });
    } else if (t.type === "REFUND" && orderId) {
      const o = orders.get(orderId);
      refunds.push({
        orderId,
        orderName,
        cents: -amount,
        date: t.transactionDate,
        order: o ? shopifyOrderToSale(o, warnings) : null,
      });
      if (fee) fees.push({ type: "shopify_payments_fee", cents: fee, orderId, description: `Refund fee ${orderName}` });
    } else if (t.type.startsWith("SHIPPING_")) {
      fees.push({ type: "shopify_shipping_label", cents: -net, orderId, description: t.type.toLowerCase() });
    } else {
      adjustments.push({
        type: t.type,
        cents: net,
        orderId,
        description: [t.type.toLowerCase(), t.adjustmentReason, t.associatedOrder?.name].filter(Boolean).join(" · "),
      });
    }
  }

  const sales: OrderSale[] = [];
  for (const [orderId, charge] of chargesByOrder) {
    const o = orders.get(orderId);
    if (!o) {
      warnings.push(`${charge.name}: order details not found; added for review`);
      sales.push({
        orderId,
        orderName: charge.name,
        orderDate: charge.date,
        destinationCountry: null,
        shippingProgram: "domestic",
        buyerCurrency: null,
        grossCents: charge.cents,
        lines: [{ lineId: `${orderId}:unknown`, sku: null, title: "Order details unavailable", quantity: 1, grossCents: charge.cents }],
        shippingCents: 0,
        gateway: "shopify_payments",
      });
      continue;
    }
    let sale = shopifyOrderToSale(o, warnings);
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
    sales,
    refunds,
    fees,
    adjustments,
    warnings,
  };
}
