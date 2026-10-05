import { describe, expect, it } from "vitest";
import { allocate, gstInclusive } from "../src/money";
import { classifyLine, classifyOrder, rescaleOrder } from "../src/rules/engine";
import { makeResolver } from "../src/db";
import type { Consignor, OrderSale, StockItem } from "../src/types";

const order = (over: Partial<OrderSale> = {}): OrderSale => ({
  orderId: "o1",
  orderName: "#1",
  orderDate: "2026-10-01",
  destinationCountry: "AU",
  shippingProgram: "domestic",
  buyerCurrency: null,
  grossCents: 110000,
  lines: [{ lineId: "l1", sku: "SKU1", title: "Juno-106", quantity: 1, grossCents: 110000 }],
  shippingCents: 0,
  gateway: "shopify_payments",
  ...over,
});
const line = (o: OrderSale) => o.lines[0]!;
const owned = (over: Partial<StockItem> = {}): StockItem => ({
  sku: "SKU1",
  ownership: "owned",
  acquiredFrom: "registered_supplier",
  source: "item",
  ...over,
});
const consignor = (over: Partial<Consignor> = {}): Consignor => ({
  id: 1,
  name: "John Smith",
  gstRegistered: false,
  commissionType: "percent",
  commissionValue: 20,
  agreementType: "agency",
  ...over,
});

describe("money", () => {
  it("allocate always sums to the total", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(-100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-100);
    expect(allocate(96500, [6500, 85405, 4595]).reduce((a, b) => a + b, 0)).toBe(96500);
  });
  it("GST is 1/11 of the inclusive amount", () => {
    expect(gstInclusive(110000)).toBe(10000);
    expect(gstInclusive(28405)).toBe(2582); // Shopify charged $25.82 on #3254
    expect(gstInclusive(-110000)).toBe(-10000);
  });
});

describe("A: stock LOFI owns", () => {
  it("A1: $1,100 sale -> $100 GST", () => {
    const o = order();
    const r = classifyLine(o, line(o), owned());
    expect(r.scenario).toBe("A1");
    expect(r.gstCents).toBe(10000);
    expect(r.approval).toBe("draft"); // nothing signed off yet
    expect(r.postings).toEqual([{ account: "Sales – Stock", taxCode: "GST", grossCents: 110000, gstCents: 10000, memo: undefined }]);
  });

  it("A2: bought $1,000 privately, sold $1,650 -> $150 GST and $90.91 Division 66 credit", () => {
    const o = order({ grossCents: 165000, lines: [{ ...line(order()), grossCents: 165000 }] });
    const r = classifyLine(o, line(o), owned({ acquiredFrom: "private_seller", purchaseCents: 100000 }));
    expect(r.scenario).toBe("A2");
    expect(r.gstCents).toBe(15000);
    expect(r.notionalItcCents).toBe(9091);
  });

  it("A2: credit capped at the GST on the sale", () => {
    const o = order();
    const r = classifyLine(o, line(o), owned({ acquiredFrom: "private_seller", purchaseCents: 200000 }));
    expect(r.notionalItcCents).toBe(10000);
  });

  it("A2: purchase of $300 or less has no credit at sale", () => {
    const o = order();
    const r = classifyLine(o, line(o), owned({ acquiredFrom: "private_seller", purchaseCents: 25000 }));
    expect(r.notionalItcCents).toBe(0);
    expect(r.flags.join()).toMatch(/purchase period/);
  });

  it("A2: missing purchase price is flagged", () => {
    const o = order();
    const r = classifyLine(o, line(o), owned({ acquiredFrom: "private_seller" }));
    expect(r.flags.join()).toMatch(/Purchase price missing/);
  });

  it("A3: trade-in resold is a full taxable sale", () => {
    const o = order();
    const r = classifyLine(o, line(o), owned({ acquiredFrom: "trade_in", purchaseCents: 70000 }));
    expect(r.scenario).toBe("A3");
    expect(r.gstCents).toBe(10000);
    expect(r.notionalItcCents).toBe(6364);
  });
});

describe("B: consignment", () => {
  it("B1: $1,100 at 20% -> $880 to consignor, $220 commission with $20 GST", () => {
    const o = order();
    const r = classifyLine(o, line(o), { ...owned(), ownership: "consignment", consignor: consignor() });
    expect(r.scenario).toBe("B1");
    expect(r.gstCents).toBe(2000);
    expect(r.postings.map((p) => [p.account, p.taxCode, p.grossCents, p.gstCents])).toEqual([
      ["Consignor Payable", "NO_GST", 88000, 0],
      ["Consignment Commission Income", "GST", 22000, 2000],
    ]);
  });

  it("B2 agency: same split, consignor reports GST on the sale", () => {
    const o = order();
    const r = classifyLine(o, line(o), { ...owned(), ownership: "consignment", consignor: consignor({ gstRegistered: true }) });
    expect(r.scenario).toBe("B2_AGENCY");
    expect(r.gstCents).toBe(2000);
  });

  it("B2 153-B: LOFI reports GST on the full sale and records a bill from the consignor", () => {
    const o = order();
    const r = classifyLine(o, line(o), {
      ...owned(),
      ownership: "consignment",
      consignor: consignor({ gstRegistered: true, agreementType: "153B" }),
    });
    expect(r.scenario).toBe("B2_153B");
    expect(r.gstCents).toBe(10000);
    expect(r.flags.join()).toMatch(/\$880\.00/);
  });

  it("item commission overrides the consignor's default", () => {
    const o = order();
    const r = classifyLine(o, line(o), {
      ...owned(),
      ownership: "consignment",
      consignor: consignor(),
      commissionType: "fixed",
      commissionValue: 150,
    });
    expect(r.postings[1]!.grossCents).toBe(15000);
  });

  it("consignment with no consignor goes to review", () => {
    const o = order();
    expect(classifyLine(o, line(o), { ...owned(), ownership: "consignment" }).scenario).toBe("REVIEW");
  });
});

describe("C: overseas", () => {
  const us = order({ destinationCountry: "US", shippingProgram: "direct_export" });
  it("C1: owned stock shipped overseas by LOFI is GST-free", () => {
    const r = classifyLine(us, line(us), owned());
    expect(r.scenario).toBe("C1");
    expect(r.gstCents).toBe(0);
    expect(r.postings[0]!.taxCode).toBe("GST_FREE_EXPORT");
  });
  it("C2: eBay International Shipping goes to review until decided", () => {
    const de = order({ destinationCountry: "DE", shippingProgram: "ebay_international" });
    const r = classifyLine(de, line(de), owned());
    expect(r.scenario).toBe("C2");
    expect(r.approval).toBe("review");
  });
  it("C3: consigned item exported: commission still taxable", () => {
    const r = classifyLine(us, line(us), { ...owned(), ownership: "consignment", consignor: consignor() });
    expect(r.scenario).toBe("C3");
    expect(r.gstCents).toBe(2000);
  });
  it("foreign-currency buyer is flagged (C4)", () => {
    const o = order({ buyerCurrency: "USD" });
    expect(classifyLine(o, line(o), owned()).flags.join()).toMatch(/C4/);
  });
});

describe("precedence and lookups", () => {
  const resolve = makeResolver(
    [
      {
        sku: "RM-1",
        title: null,
        ownership: "consignment",
        acquired_from: null,
        purchase_cents: null,
        purchase_date: null,
        seller_name: null,
        seller_address: null,
        seller_description: null,
        consignor_id: 1,
        commission_type: null,
        commission_value: null,
        override_scenario: null,
      },
    ],
    [
      { prefix: "RM-", ownership: "owned", acquired_from: "registered_supplier", consignor_id: null, commission_type: null, commission_value: null },
      { prefix: "RM-25", ownership: "owned", acquired_from: "private_seller", consignor_id: null, commission_type: null, commission_value: null },
    ],
    [{ id: 1, name: "J", gst_registered: 0, commission_type: "percent", commission_value: 25, agreement_type: "agency" }],
  );

  it("an item's own record beats a prefix rule", () => {
    expect(resolve("rm-1")?.ownership).toBe("consignment");
    expect(resolve("rm-1")?.consignor?.commissionValue).toBe(25);
  });
  it("longest prefix wins", () => {
    expect(resolve("RM-256549-001196-140526")?.acquiredFrom).toBe("private_seller");
    expect(resolve("RM-9")?.acquiredFrom).toBe("registered_supplier");
  });
  it("unknown SKU -> review", () => {
    expect(resolve("ZZZ")).toBeNull();
    const o = order({ lines: [{ ...line(order()), sku: "ZZZ" }] });
    expect(classifyLine(o, line(o), resolve("ZZZ")).scenario).toBe("REVIEW");
  });
  it("manual override wins over every rule", () => {
    const us = order({ destinationCountry: "US", shippingProgram: "direct_export" });
    expect(classifyLine(us, line(us), owned({ overrideScenario: "A1" })).scenario).toBe("A1");
  });
});

describe("shipping and refunds", () => {
  it("D2: domestic shipping is taxable, and lines + shipping add up", () => {
    const o = order({
      grossCents: 96500,
      shippingCents: 4595,
      lines: [
        { lineId: "a", sku: "A", title: "Stepdown", quantity: 1, grossCents: 6500 },
        { lineId: "b", sku: "B", title: "Wavestation", quantity: 1, grossCents: 85405 },
      ],
    });
    const out = classifyOrder(o, () => owned());
    expect(out).toHaveLength(3);
    expect(out.reduce((a, l) => a + l.grossCents, 0)).toBe(96500);
    expect(out[2]!.gstCents).toBe(gstInclusive(4595));
  });
  it("D2: shipping on an export is GST-free", () => {
    const o = order({ destinationCountry: "JP", shippingProgram: "direct_export", grossCents: 115000, shippingCents: 5000 });
    expect(classifyOrder(o, () => owned())[1]!.postings[0]!.taxCode).toBe("GST_FREE_EXPORT");
  });
  it("D3: a refund reverses with the original scenario", () => {
    const o = order();
    const refund = classifyOrder(rescaleOrder(o, -55000), () => ({ ...owned(), ownership: "consignment", consignor: consignor() }));
    expect(refund[0]!.scenario).toBe("B1");
    expect(refund[0]!.grossCents).toBe(-55000);
    expect(refund[0]!.gstCents).toBe(-1000);
  });
});
