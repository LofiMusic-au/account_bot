import { describe, expect, it } from "vitest";
import { normaliseShopifyPayout, type ShopifyBalanceTxn, type ShopifyOrder } from "../src/channels/shopify";
import { normaliseEbayPayout, type EbayOrder, type EbayTransaction } from "../src/channels/ebay";
import { buildReport } from "../src/reconcile";
import type { StockItem } from "../src/types";

// Order shapes taken from LOFI's live Shopify store (#3252, #3254), amounts unchanged.
const money = (amount: string) => ({ shopMoney: { amount } });
const li = (id: string, sku: string, name: string, amount: string) => ({
  id,
  sku,
  name,
  quantity: 1,
  originalTotalSet: money(amount),
  discountAllocations: [],
  taxLines: [{ priceSet: money("0") }],
});
const orders = new Map<string, ShopifyOrder>([
  [
    "gid://shopify/Order/3252",
    {
      id: "gid://shopify/Order/3252",
      name: "#3252",
      createdAt: "2026-10-05T01:27:52Z",
      presentmentCurrencyCode: "AUD",
      paymentGatewayNames: ["shopify_payments"],
      taxesIncluded: true,
      shippingAddress: { countryCodeV2: "AU" },
      totalShippingPriceSet: money("45.95"),
      totalPriceSet: money("965.0"),
      lineItems: {
        nodes: [
          li("l1", "240/100_Stepdown", "240V - 100V 50W Isolated Step-Down Transformer", "65.0"),
          li("l2", "RM-256549-001196-140526", "Korg Wavestation A/D Synthesiser Rack", "854.05"),
        ],
      },
    },
  ],
  [
    "gid://shopify/Order/3254",
    {
      id: "gid://shopify/Order/3254",
      name: "#3254",
      createdAt: "2026-10-05T07:53:53Z",
      presentmentCurrencyCode: "AUD",
      paymentGatewayNames: ["shopify_payments"],
      taxesIncluded: true,
      shippingAddress: { countryCodeV2: "AU" },
      totalShippingPriceSet: money("29.95"),
      totalPriceSet: money("314.0"),
      lineItems: { nodes: [li("l3", "L-060256-11-100926", "Pioneer CDJ-1000MK3", "284.05")] },
    },
  ],
]);

const m = (a: string) => ({ amount: a, currencyCode: "AUD" });
const txn = (id: string, type: string, amount: string, fee: string, order?: string): ShopifyBalanceTxn => ({
  id,
  type,
  sourceType: type,
  test: false,
  transactionDate: "2026-10-05T08:00:00Z",
  adjustmentReason: null,
  amount: m(amount),
  fee: m(fee),
  net: m((Number(amount) - Number(fee)).toFixed(2)),
  associatedOrder: order ? { id: `gid://shopify/Order/${order}`, name: `#${order}` } : null,
});

const stock: Record<string, StockItem> = {
  "240/100_STEPDOWN": { sku: "240/100_Stepdown", ownership: "owned", acquiredFrom: "registered_supplier", source: "item" },
  "RM-256549-001196-140526": {
    sku: "RM-256549-001196-140526",
    ownership: "consignment",
    consignor: { id: 1, name: "C", gstRegistered: false, commissionType: "percent", commissionValue: 25, agreementType: "agency" },
    source: "item",
  },
};
const resolve = (sku: string | null) => (sku ? (stock[sku.toUpperCase()] ?? null) : null);

describe("Shopify payout", () => {
  const txns = [
    txn("t1", "CHARGE", "965.00", "17.37", "3252"),
    txn("t2", "CHARGE", "314.00", "5.65", "3254"),
    txn("t3", "ADJUSTMENT", "-2.00", "0", undefined),
  ];
  const net = 965 - 17.37 + 314 - 5.65 - 2;
  const payout = normaliseShopifyPayout(
    { id: "p", legacyResourceId: "999", issuedAt: "2026-10-06T00:00:00Z", status: "PAID", transactionType: "DEPOSIT", net: m(net.toFixed(2)) },
    txns,
    orders,
  );
  const report = buildReport(payout, resolve, new Date("2026-10-06T00:00:00Z"));

  it("rebuilds to the deposit to the cent", () => {
    expect(report.expectedCents).toBe(report.netCents);
    expect(report.differenceCents).toBe(0);
    expect(report.totals.feesCents).toBe(1737 + 565);
  });

  it("splits each order into lines + shipping with the right scenarios", () => {
    const byLine = Object.fromEntries(report.sales.map((l) => [l.lineId, l]));
    expect(byLine["l1"]!.scenario).toBe("A1");
    expect(byLine["l1"]!.gstCents).toBe(591); // matches Shopify's $5.91
    expect(byLine["l2"]!.scenario).toBe("B1");
    // 25% commission on $854.05 = $213.51; GST $19.41, not Shopify's $77.64
    expect(byLine["l2"]!.gstCents).toBe(1941);
    expect(byLine["l3"]!.scenario).toBe("REVIEW"); // no stock record for the CDJ
  });

  it("is flagged for review because one SKU is unknown", () => {
    expect(report.status).toBe("needs_review");
    expect(report.reviewCount).toBe(2); // the CDJ, and #3254's shipping that follows it
  });

  it("splits a part-paid order in proportion and warns", () => {
    const p = normaliseShopifyPayout(
      { id: "p", legacyResourceId: "1", issuedAt: "2026-10-06T00:00:00Z", status: "PAID", transactionType: "DEPOSIT", net: m("500.00") },
      [txn("t1", "CHARGE", "500.00", "0", "3252")],
      orders,
    );
    expect(p.sales[0]!.grossCents).toBe(50000);
    expect(p.sales[0]!.lines.reduce((a, l) => a + l.grossCents, 0) + p.sales[0]!.shippingCents).toBe(50000);
    expect(p.warnings.join()).toMatch(/part-paid/);
  });

  it("reverses a refund with the original scenarios", () => {
    const p = normaliseShopifyPayout(
      { id: "p", legacyResourceId: "2", issuedAt: "2026-10-06T00:00:00Z", status: "PAID", transactionType: "DEPOSIT", net: m("-65.00") },
      [txn("r1", "REFUND", "-65.00", "0", "3252")],
      orders,
    );
    const r = buildReport(p, resolve);
    expect(r.differenceCents).toBe(0);
    expect(r.refunds.reduce((a, l) => a + l.grossCents, 0)).toBe(-6500);
  });
});

describe("eBay payout", () => {
  const order: EbayOrder = {
    orderId: "12-34567-89012",
    creationDate: "2026-10-01T00:00:00Z",
    lineItems: [
      {
        lineItemId: "li1",
        sku: "240/100_Stepdown",
        title: "Step-down transformer",
        quantity: 1,
        lineItemCost: { value: "65.00", currency: "AUD" },
        deliveryCost: { shippingCost: { value: "15.00", currency: "AUD" } },
      },
    ],
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { contactAddress: { countryCode: "AU" } } } }],
  };
  const sale: EbayTransaction = {
    transactionId: "t1",
    transactionType: "SALE",
    transactionDate: "2026-10-02T00:00:00Z",
    bookingEntry: "CREDIT",
    amount: { value: "69.60", currency: "AUD" },
    orderId: order.orderId,
    totalFeeAmount: { value: "10.40", currency: "AUD" },
    orderLineItems: [
      {
        lineItemId: "li1",
        marketplaceFees: [
          { feeType: "FINAL_VALUE_FEE", amount: { value: "10.10", currency: "AUD" } },
          { feeType: "FINAL_VALUE_FEE_FIXED_PER_ORDER", amount: { value: "0.30", currency: "AUD" } },
        ],
      },
    ],
  };
  const ad: EbayTransaction = {
    transactionId: "t2",
    transactionType: "NON_SALE_CHARGE",
    transactionDate: "2026-10-02T00:00:00Z",
    bookingEntry: "DEBIT",
    amount: { value: "4.00", currency: "AUD" },
    feeType: "AD_FEE",
  };

  it("adds sale gross back from net + fees and balances", () => {
    const p = normaliseEbayPayout(
      { payoutId: "5001", payoutStatus: "SUCCEEDED", payoutDate: "2026-10-03T00:00:00Z", amount: { value: "65.60", currency: "AUD" } },
      [sale, ad],
      new Map([[order.orderId, order]]),
    );
    expect(p.sales[0]!.grossCents).toBe(8000);
    expect(p.fees.map((f) => f.type)).toEqual([
      "ebay_final_value_fee",
      "ebay_final_value_fee_fixed_per_order",
      "ebay_promoted_listing_fee",
    ]);
    const r = buildReport(p, resolve);
    expect(r.differenceCents).toBe(0);
    expect(r.totals.gstCents).toBe(591 + 136); // item + shipping
  });

  it("detects eBay International Shipping and sends it to review", () => {
    const eis: EbayOrder = {
      ...order,
      program: { ebayInternationalShipping: {} },
      fulfillmentStartInstructions: [{ ebaySupportedFulfillment: true, finalDestinationAddress: { countryCode: "DE" } }],
    };
    const p = normaliseEbayPayout(
      { payoutId: "5002", payoutStatus: "SUCCEEDED", payoutDate: "2026-10-03T00:00:00Z", amount: { value: "69.60", currency: "AUD" } },
      [sale],
      new Map([[order.orderId, eis]]),
    );
    expect(p.sales[0]!.shippingProgram).toBe("ebay_international");
    expect(p.sales[0]!.destinationCountry).toBe("DE");
    const r = buildReport(p, resolve);
    expect(r.sales[0]!.scenario).toBe("C2");
    expect(r.status).toBe("needs_review");
  });

  it("an unexplained difference marks the payout unbalanced", () => {
    const p = normaliseEbayPayout(
      { payoutId: "5003", payoutStatus: "SUCCEEDED", payoutDate: "2026-10-03T00:00:00Z", amount: { value: "70.00", currency: "AUD" } },
      [sale],
      new Map([[order.orderId, order]]),
    );
    const r = buildReport(p, resolve);
    expect(r.differenceCents).toBe(40);
    expect(r.status).toBe("unbalanced");
  });
});
