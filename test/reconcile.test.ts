// Payout reconstruction tests: both channels normalise into the same model and
// reconcile to the actual payout to the cent, with every unknown surfaced.

import { describe, expect, it } from "vitest";
import { buildReport } from "../src/reconcile";
import { ebayFixture, fixtureResolver, shopifyFixture } from "./helpers";
import type { Issue } from "../src/types";

const resolve = fixtureResolver();
const codes = (issues: Issue[], severity?: string) => issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);
const now = new Date("2026-10-08T06:00:00Z");

describe("eBay fixture payout", () => {
  const payout = ebayFixture();
  const report = buildReport(payout, resolve, now);
  const line = (sku: string) => report.sales.find((l) => l.sku === sku)!;

  it("normalises sales, refunds, fees and adjustments with source IDs", () => {
    expect(payout.sales.map((s) => s.orderId)).toEqual(["26-00001-00001", "26-00002-00002", "26-00003-00003"]);
    expect(payout.refunds).toHaveLength(1);
    expect(payout.fees.map((f) => [f.type, f.category, f.cents])).toEqual([
      ["ebay_final_value_fee", "marketplace", 5252],
      ["ebay_final_value_fee_fixed_per_order", "marketplace", 30],
      ["ebay_final_value_fee", "marketplace", 3030],
      ["ebay_final_value_fee", "marketplace", 2640],
      ["ebay_international_fee", "marketplace", 360],
      ["ebay_final_value_fee_fixed_per_order", "marketplace", 30],
      ["ebay_final_value_fee", "marketplace", 12000],
      ["ebay_final_value_fee_fixed_per_order", "marketplace", 30],
      ["ebay_promoted_listing_fee", "advertising", 2550],
      ["ebay_shipping_label", "shipping_label", 1240],
    ]);
    expect(payout.fees[0]!.source).toMatchObject({ platform: "ebay", payoutId: "7001", transactionId: "26-00001-00001", lineItemId: "1001", rawAmount: "52.52" });
    expect(payout.sales[0]!.sources[0]).toMatchObject({ transactionType: "SALE", rawAmount: "736.88", rawCurrency: "AUD" });
    expect(payout.adjustments).toEqual([
      expect.objectContaining({ type: "CREDIT", cents: 500, supported: true }),
    ]);
  });

  it("keeps raw transactions with buyer details removed", () => {
    expect(payout.raw.transactions).toHaveLength(7);
    expect(JSON.stringify(payout.raw.transactions)).not.toContain("some_buyer");
    expect(JSON.stringify(payout.raw.orders)).not.toContain("REDACTED");
  });

  it("reconstructs the payout to the cent", () => {
    expect(report.netCents).toBe(174338);
    expect(report.expectedCents).toBe(174338);
    expect(report.differenceCents).toBe(0);
    expect(report.breakdown).toEqual({
      itemsCents: 210000,
      shippingCents: 6000,
      discountsCents: 5000,
      salesGrossCents: 216000,
      refundsCents: 15000,
      feesByCategory: { marketplace: 23372, payment: 0, advertising: 2550, shipping_label: 1240, other: 0 },
      feesCents: 27162,
      adjustmentsCents: 500,
      unsupportedCents: 0,
    });
  });

  it("classifies every line from stock facts", () => {
    expect(line("L-500-A").scenario).toBe("A1");
    expect(line("L-300-B")).toMatchObject({ scenario: "A2", division66Candidate: true, discountCents: 5000, grossCents: 30000, gstCents: 2727 });
    expect(line("L-300-B").notionalItcCents).toBe(0); // bought for $120: credit belongs to the purchase period
    expect(line("L-NZ-1")).toMatchObject({ scenario: "C1", gstCents: 0 });
    expect(line("RM-CONS-1")).toMatchObject({ scenario: "B1", gstCents: 2500 }); // 25% of $1,100 = $275
    const refund = report.refunds.find((l) => l.sku === "L-REF-1")!;
    expect(refund).toMatchObject({ scenario: "A2", grossCents: -15000, gstCents: -1364, notionalItcCents: -1364 });
  });

  it("balances and has no missing facts, but stays provisional", () => {
    expect(codes(report.issues, "blocking")).toEqual([]);
    expect(report.status).toBe("ready");
    expect(report.provisional).toBe(true);
    expect(codes(report.issues, "signoff")).toEqual(expect.arrayContaining(["unsigned_scenario", "unknown_fee_tax"]));
  });

  it("surfaces an unknown transaction type instead of hiding it", () => {
    const p = ebayFixture((f) => {
      f.transactions.push({
        transactionId: "LR-1",
        transactionType: "LOAN_REPAYMENT",
        transactionDate: "2026-10-07T08:00:00.000Z",
        bookingEntry: "DEBIT",
        amount: { value: "10.00", currency: "AUD" },
      });
      f.payout.amount.value = "1733.38";
    });
    const r = buildReport(p, resolve, now);
    expect(r.differenceCents).toBe(0);
    expect(r.breakdown.unsupportedCents).toBe(-1000);
    expect(r.status).toBe("needs_review");
    expect(r.issues.find((i) => i.code === "unsupported_transaction_type")).toMatchObject({ transactionId: "LR-1", cents: -1000 });
  });

  it("a sale that doesn't match its order blocks, even though the payout balances", () => {
    const p = ebayFixture((f) => {
      f.transactions[0]!.amount.value = "737.88";
      f.payout.amount.value = "1744.38";
    });
    const r = buildReport(p, resolve, now);
    expect(r.differenceCents).toBe(0);
    expect(codes(r.issues, "blocking")).toContain("sale_amount_mismatch");
    expect(r.status).toBe("needs_review");
  });

  it("an unexplained difference marks the payout unbalanced", () => {
    const r = buildReport(ebayFixture((f) => void (f.payout.amount.value = "1743.40")), resolve, now);
    expect(r.differenceCents).toBe(2);
    expect(r.status).toBe("unbalanced");
    expect(codes(r.issues)).toContain("payout_mismatch");
  });

  it("eBay International Shipping goes to review", () => {
    const p = ebayFixture((f) => {
      f.orders[1]!.program = { ebayInternationalShipping: {} };
      f.orders[1]!.fulfillmentStartInstructions = [{ ebaySupportedFulfillment: true, finalDestinationAddress: { countryCode: "DE" } }];
    });
    const r = buildReport(p, resolve, now);
    expect(r.sales.find((l) => l.sku === "L-NZ-1")).toMatchObject({ scenario: "C2", approval: "review" });
    expect(r.status).toBe("needs_review");
  });

  it("a dispute is known but always needs a person", () => {
    const p = ebayFixture((f) => {
      f.transactions.push({
        transactionId: "D-1",
        transactionType: "DISPUTE",
        transactionDate: "2026-10-07T08:00:00.000Z",
        bookingEntry: "DEBIT",
        amount: { value: "50.00", currency: "AUD" },
        orderId: "26-00001-00001",
      });
      f.payout.amount.value = "1693.38";
    });
    const r = buildReport(p, resolve, now);
    expect(r.differenceCents).toBe(0);
    expect(codes(r.issues, "blocking")).toEqual(["dispute"]);
  });
});

describe("Shopify fixture payout", () => {
  const payout = shopifyFixture();
  const report = buildReport(payout, resolve, now);
  const line = (sku: string) => report.sales.find((l) => l.sku === sku)!;

  it("reconstructs the payout to the cent", () => {
    expect(report.netCents).toBe(172616);
    expect(report.differenceCents).toBe(0);
    expect(report.breakdown).toEqual({
      itemsCents: 177905,
      shippingCents: 12595,
      discountsCents: 4000,
      salesGrossCents: 190500,
      refundsCents: 10000,
      feesByCategory: { marketplace: 0, payment: 6189, advertising: 0, shipping_label: 1495, other: 0 },
      feesCents: 7684,
      adjustmentsCents: -200,
      unsupportedCents: 0,
    });
  });

  it("keeps Shopify source IDs on sales, fees and adjustments", () => {
    expect(line("L-DISC-1").sources[0]).toMatchObject({ platform: "shopify", payoutId: "9001", transactionId: "gid://shopify/ShopifyPaymentsBalanceTransaction/2", rawAmount: "380.00" });
    expect(payout.fees.find((f) => f.type === "shopify_chargeback_fee")!.source.transactionId).toBe("gid://shopify/ShopifyPaymentsBalanceTransaction/7");
    expect(payout.adjustments[0]!.source.transactionType).toBe("ADJUSTMENT");
  });

  it("splits multi-line orders and applies discounts per line", () => {
    expect(line("240/100_Stepdown")).toMatchObject({ scenario: "A1", gstCents: 591 });
    // Shopify charged $77.64 GST on the consigned Wavestation; at 25% commission the draft B1 GST is $19.41.
    expect(line("RM-256549-001196-140526")).toMatchObject({ scenario: "B1", gstCents: 1941 });
    expect(line("L-DISC-1")).toMatchObject({ scenario: "A1", grossCents: 36000, discountCents: 4000, gstCents: 3273 });
    expect(line("L-NZ-2")).toMatchObject({ scenario: "C1", division66Candidate: true, gstCents: 0 });
  });

  it("reverses the refund with the original sale's scenario", () => {
    expect(report.refunds.reduce((a, l) => a + l.grossCents, 0)).toBe(-10000);
    expect(report.refunds[0]).toMatchObject({ sku: "L-mk3-0010230-300726", scenario: "A2" });
  });

  it("is ready and provisional", () => {
    expect(codes(report.issues, "blocking")).toEqual([]);
    expect(report.status).toBe("ready");
    expect(report.provisional).toBe(true);
  });

  it("surfaces an unknown transaction type", () => {
    const p = shopifyFixture((f) => {
      f.transactions.push({
        ...f.transactions[5]!,
        id: "gid://shopify/ShopifyPaymentsBalanceTransaction/8",
        type: "SHOP_CASH_CREDIT",
        amount: { amount: "3.00", currencyCode: "AUD" },
        net: { amount: "3.00", currencyCode: "AUD" },
      });
      f.payout.net.amount = "1729.16";
    });
    const r = buildReport(p, resolve, now);
    expect(r.differenceCents).toBe(0);
    expect(r.breakdown.unsupportedCents).toBe(300);
    expect(codes(r.issues, "blocking")).toEqual(["unsupported_transaction_type"]);
    expect(r.status).toBe("needs_review");
  });

  it("CURRENCY_CONVERSION (new in API 2026-10) is surfaced as unsupported, not ignored", () => {
    const p = shopifyFixture((f) => {
      f.transactions.push({
        ...f.transactions[5]!,
        id: "gid://shopify/ShopifyPaymentsBalanceTransaction/9",
        type: "CURRENCY_CONVERSION",
        amount: { amount: "-1.25", currencyCode: "AUD" },
        net: { amount: "-1.25", currencyCode: "AUD" },
      });
      f.payout.net.amount = "1724.91";
    });
    const r = buildReport(p, resolve, now);
    expect(r.differenceCents).toBe(0);
    expect(r.issues.find((i) => i.code === "unsupported_transaction_type")!.message).toMatch(/CURRENCY_CONVERSION/);
  });

  it("an order without a shipping address has an unknown destination", () => {
    const r = buildReport(shopifyFixture((f) => void (f.orders[1]!.shippingAddress = null)), resolve, now);
    expect(r.issues.find((i) => i.code === "unknown_destination")).toMatchObject({ orderId: "gid://shopify/Order/3260" });
  });

  it("test transactions and unmatched refunds block the payout", () => {
    const r = buildReport(
      shopifyFixture((f) => {
        f.transactions[0]!.test = true;
        f.orders.pop(); // #3250, the refunded order
      }),
      resolve,
      now,
    );
    expect(codes(r.issues, "blocking")).toEqual(expect.arrayContaining(["test_transaction", "order_details_missing", "refund_unmatched"]));
  });

  it("splits a part-paid order in proportion and notes it", () => {
    const p = shopifyFixture((f) => {
      f.transactions = [{ ...f.transactions[0]!, amount: { amount: "500.00", currencyCode: "AUD" }, fee: { amount: "0.00", currencyCode: "AUD" }, net: { amount: "500.00", currencyCode: "AUD" } }];
      f.payout.net.amount = "500.00";
    });
    expect(p.sales[0]!.grossCents).toBe(50000);
    expect(p.sales[0]!.lines.reduce((a, l) => a + l.grossCents, 0) + p.sales[0]!.shippingCents).toBe(50000);
    expect(p.warnings.join()).toMatch(/part-paid/);
    expect(buildReport(p, resolve, now).differenceCents).toBe(0);
  });
});

describe("both channels produce the same model", () => {
  it("has the same keys on every normalised record", () => {
    const e = ebayFixture();
    const s = shopifyFixture();
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(e)).toEqual(keys(s));
    expect(keys(e.sales[0]!)).toEqual(keys(s.sales[0]!));
    expect(keys(e.sales[0]!.lines[0]!)).toEqual(keys(s.sales[0]!.lines[0]!));
    expect(keys(e.fees[0]!)).toEqual(keys(s.fees[0]!));
    expect(keys(e.refunds[0]!)).toEqual(keys(s.refunds[0]!));
    expect(keys(e.adjustments[0]!)).toEqual(keys(s.adjustments[0]!));
    expect(keys(e.fees[0]!.source)).toEqual(keys(s.fees[0]!.source));
  });
});
