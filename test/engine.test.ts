// Rules engine tests. Every scenario is unsigned-off, so these tests assert the
// draft arithmetic the engine applies *and* that the result is visibly
// provisional. They are not statements that the treatment is correct law.

import { describe, expect, it } from "vitest";
import { allocate, applyBasisPoints, divRound, gstInclusive, toCents } from "../src/money";
import { classifyLine, classifyOrder, isDivision66Candidate, rescaleOrder } from "../src/rules/engine";
import { SCENARIOS } from "../src/rules/config";
import { makeResolver } from "../src/db";
import type { Consignor, LineClassification, OrderSale, StockItem } from "../src/types";

const order = (over: Partial<OrderSale> = {}): OrderSale => ({
  orderId: "o1",
  orderName: "#1",
  orderDate: "2026-10-01",
  destinationCountry: "AU",
  shippingProgram: "domestic",
  buyerCurrency: null,
  grossCents: 110000,
  lines: [{ lineId: "l1", sku: "SKU1", title: "Juno-106", quantity: 1, grossCents: 110000, discountCents: 0 }],
  shippingCents: 0,
  gateway: "shopify_payments",
  sources: [],
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
const secondhand = (over: Partial<StockItem> = {}) => owned({ acquiredFrom: "private_seller", condition: "secondhand", ...over });
const consignor = (over: Partial<Consignor> = {}): Consignor => ({
  id: 1,
  name: "John Smith",
  gstRegistered: false,
  commissionType: "percent",
  commissionValue: 20,
  agreementType: "agency",
  ...over,
});
const consigned = (c: Partial<Consignor> = {}, over: Partial<StockItem> = {}): StockItem => ({
  ...owned(),
  acquiredFrom: null,
  ownership: "consignment",
  consignor: consignor(c),
  ...over,
});
const codes = (r: LineClassification, severity?: "blocking" | "signoff") =>
  r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

/** An unsigned-off scenario must be draft, carry a sign-off issue, and never claim approval. */
function expectProvisional(r: LineClassification) {
  expect(SCENARIOS[r.scenario].signedOff).toBe(false);
  expect(r.approval).not.toBe("approved");
  expect(codes(r, "signoff")).toContain("unsigned_scenario");
  expect(r.explanation.at(-1) ?? "").toMatch(/draft|review|Division 66/);
}

describe("money: integer cents only", () => {
  it("parses decimal strings without floats", () => {
    expect(toCents("0.1")).toBe(10);
    expect(toCents("1234.5")).toBe(123450);
    expect(toCents("-0.07")).toBe(-7);
    expect(toCents("19.99")).toBe(1999);
    expect(toCents(".5")).toBe(50);
    expect(toCents("100")).toBe(10000);
    expect(toCents("2.500")).toBe(250);
    expect(toCents(null)).toBe(0);
  });
  it("refuses sub-cent amounts and junk rather than rounding them away", () => {
    expect(() => toCents("1.005")).toThrow(/fractions of a cent/);
    expect(() => toCents("abc")).toThrow();
    expect(() => toCents("1,000.00")).toThrow();
  });
  it("divides with half-away-from-zero rounding", () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(4, 3)).toBe(1);
  });
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
  it("commission percentages use basis points", () => {
    expect(applyBasisPoints(85405, 2500)).toBe(21351);
    expect(applyBasisPoints(10000, 1250)).toBe(1250);
  });
});

describe("A: stock LOFI owns", () => {
  it("A1: GST-registered supplier -> normal taxable sale, draft", () => {
    const o = order();
    const r = classifyLine(o, line(o), owned());
    expect(r.scenario).toBe("A1");
    expect(r.gstCents).toBe(10000);
    expect(r.postings).toEqual([{ account: "Sales – Stock", taxCode: "GST", grossCents: 110000, gstCents: 10000, memo: undefined }]);
    expect(r.division66Candidate).toBe(false);
    expect(codes(r, "blocking")).toEqual([]);
    expectProvisional(r);
  });

  it("A1 explanation traces the facts used", () => {
    const o = order();
    const r = classifyLine(o, line(o), owned());
    expect(r.explanation).toEqual([
      "stock record SKU1",
      "destination = AU",
      "ownership = LOFI",
      "source_type = gst_registered_supplier",
      "supplier_gst_registered = yes",
      "→ A1: LOFI-owned stock, normal taxable sale in Australia (draft, not signed off)",
    ]);
  });

  it("A2: second-hand from a private seller -> taxable sale on the full price, Division 66 candidate", () => {
    const o = order({ grossCents: 165000, lines: [{ ...line(order()), grossCents: 165000 }] });
    const r = classifyLine(o, line(o), secondhand({ purchaseCents: 100000 }));
    expect(r.scenario).toBe("A2");
    expect(r.gstCents).toBe(15000); // full GST on the sale, not GST on a margin
    expect(r.postings).toHaveLength(1);
    expect(r.division66Candidate).toBe(true);
    expect(r.notionalItcCents).toBe(9091);
    expect(r.explanation).toContain("source_type = private_non_gst_seller");
    expect(r.explanation).toContain("condition = secondhand");
    expect(r.explanation.at(-1)).toBe("→ Division 66 candidate");
    expectProvisional(r);
  });

  it("A2: credit capped at the GST on the sale", () => {
    const o = order();
    expect(classifyLine(o, line(o), secondhand({ purchaseCents: 200000 })).notionalItcCents).toBe(10000);
  });

  it("A2: purchase of $300 or less has no credit at sale", () => {
    const o = order();
    const r = classifyLine(o, line(o), secondhand({ purchaseCents: 25000 }));
    expect(r.notionalItcCents).toBe(0);
    expect(r.flags.join()).toMatch(/purchase period/);
  });

  it("A2: missing purchase price blocks the payout", () => {
    const o = order();
    const r = classifyLine(o, line(o), secondhand());
    expect(codes(r, "blocking")).toEqual(["unknown_purchase_price"]);
  });

  it("A3: trade-in is held for review until the accountant decides", () => {
    const o = order();
    const r = classifyLine(o, line(o), owned({ acquiredFrom: "trade_in", condition: "secondhand", purchaseCents: 70000 }));
    expect(r.scenario).toBe("A3");
    expect(r.approval).toBe("review");
    expect(codes(r, "blocking")).toContain("unresolved_scenario");
    // the draft figures are still shown for comparison
    expect(r.gstCents).toBe(10000);
    expect(r.division66Candidate).toBe(true);
  });
});

describe("Division 66 is derived from facts, never tagged", () => {
  it("needs LOFI ownership, a non-GST source and second-hand condition", () => {
    expect(isDivision66Candidate(secondhand())).toBe(true);
    expect(isDivision66Candidate(owned({ acquiredFrom: "trade_in", condition: "secondhand" }))).toBe(true);
    expect(isDivision66Candidate(owned({ acquiredFrom: "registered_supplier", condition: "secondhand" }))).toBe(false);
    expect(isDivision66Candidate(secondhand({ condition: "new" }))).toBe(false);
    expect(isDivision66Candidate(secondhand({ condition: null }))).toBe(false);
    expect(isDivision66Candidate(consigned())).toBe(false);
  });
});

describe("missing facts go to review, never to a guess", () => {
  const o = order();
  it("unknown acquisition source", () => {
    const r = classifyLine(o, line(o), owned({ acquiredFrom: null }));
    expect(r.scenario).toBe("REVIEW");
    expect(codes(r)).toEqual(["unknown_acquisition_source"]);
    expect(r.explanation).toContain("source_type = unknown");
  });
  it("acquired from 'other'", () => {
    expect(codes(classifyLine(o, line(o), owned({ acquiredFrom: "other" })))).toEqual(["manual_review"]);
  });
  it("private seller with unknown condition", () => {
    expect(codes(classifyLine(o, line(o), secondhand({ condition: null })))).toEqual(["unknown_condition"]);
  });
  it("new goods from a private seller have no scenario", () => {
    expect(classifyLine(o, line(o), secondhand({ condition: "new" })).scenario).toBe("REVIEW");
  });
  it("consignor with unknown GST status", () => {
    const r = classifyLine(o, line(o), consigned({ gstRegistered: null }));
    expect(r.scenario).toBe("REVIEW");
    expect(r.issues[0]).toMatchObject({ code: "unknown_consignor_gst_status", consignorId: 1 });
  });
  it("consignment with no consignor", () => {
    expect(codes(classifyLine(o, line(o), { ...owned(), ownership: "consignment" }))).toEqual(["unknown_consignor"]);
  });
  it("consigned item with no commission rate", () => {
    const r = classifyLine(o, line(o), consigned({ commissionType: undefined as never, commissionValue: undefined as never }));
    expect(codes(r)).toEqual(["unknown_commission"]);
  });
  it("unknown destination", () => {
    const pickup = order({ destinationCountry: null, shippingProgram: "unknown" });
    expect(codes(classifyLine(pickup, line(pickup), owned()))).toEqual(["unknown_destination"]);
  });
  it("unknown SKU and missing SKU", () => {
    expect(codes(classifyLine(o, line(o), null))).toEqual(["unknown_stock_record"]);
    const noSku = order({ lines: [{ ...line(o), sku: null }] });
    expect(codes(classifyLine(noSku, line(noSku), null))).toEqual(["unknown_sku"]);
  });
});

describe("B: consignment (all unsigned-off)", () => {
  it("B1: draft split $880 to consignor, $220 commission with $20 GST", () => {
    const o = order();
    const r = classifyLine(o, line(o), consigned());
    expect(r.scenario).toBe("B1");
    expect(r.gstCents).toBe(2000);
    expect(r.postings.map((p) => [p.account, p.taxCode, p.grossCents, p.gstCents])).toEqual([
      ["Consignor Payable", "NO_GST", 88000, 0],
      ["Consignment Commission Income", "GST", 22000, 2000],
    ]);
    expect(r.explanation).toContain("consignor_gst_registered = no");
    expectProvisional(r);
  });

  it("B2 agency: draft, consignor reports GST on the sale", () => {
    const o = order();
    const r = classifyLine(o, line(o), consigned({ gstRegistered: true }));
    expect(r.scenario).toBe("B2_AGENCY");
    expect(r.gstCents).toBe(2000);
    expectProvisional(r);
  });

  it("B2 153-B: draft, LOFI reports GST on the full sale and records a bill", () => {
    const o = order();
    const r = classifyLine(o, line(o), consigned({ gstRegistered: true, agreementType: "153B" }));
    expect(r.scenario).toBe("B2_153B");
    expect(r.gstCents).toBe(10000);
    expect(r.flags.join()).toMatch(/\$880\.00/);
    expectProvisional(r);
  });

  it("item commission overrides the consignor's default", () => {
    const o = order();
    const r = classifyLine(o, line(o), consigned({}, { commissionType: "fixed", commissionValue: 150 }));
    expect(r.postings[1]!.grossCents).toBe(15000);
  });
});

describe("C: overseas", () => {
  const us = order({ destinationCountry: "US", shippingProgram: "direct_export" });
  it("C1: owned stock shipped overseas by LOFI is GST-free (draft)", () => {
    const r = classifyLine(us, line(us), owned());
    expect(r.scenario).toBe("C1");
    expect(r.gstCents).toBe(0);
    expect(r.postings[0]!.taxCode).toBe("GST_FREE_EXPORT");
    expectProvisional(r);
  });
  it("C1 doesn't need the acquisition source", () => {
    expect(classifyLine(us, line(us), owned({ acquiredFrom: null })).scenario).toBe("C1");
  });
  it("C2: eBay International Shipping goes to review until decided", () => {
    const de = order({ destinationCountry: "DE", shippingProgram: "ebay_international" });
    const r = classifyLine(de, line(de), owned());
    expect(r.scenario).toBe("C2");
    expect(r.approval).toBe("review");
    expect(r.postings).toEqual([]);
    expect(codes(r, "blocking")).toContain("unresolved_scenario");
  });
  it("C3: consigned item exported: commission still taxable (draft)", () => {
    const r = classifyLine(us, line(us), consigned());
    expect(r.scenario).toBe("C3");
    expect(r.gstCents).toBe(2000);
    expectProvisional(r);
  });
  it("foreign-currency buyer is flagged (C4) and awaits sign-off", () => {
    const o = order({ buyerCurrency: "USD" });
    const r = classifyLine(o, line(o), owned());
    expect(r.flags.join()).toMatch(/C4/);
    expect(codes(r, "signoff")).toContain("fx_policy_pending");
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
    [{ id: 1, name: "J", gst_registered: 0, gst_status: null, commission_type: "percent", commission_value: 25, agreement_type: "agency" }],
  );

  it("an item's own record beats a prefix rule", () => {
    expect(resolve("rm-1")?.ownership).toBe("consignment");
    expect(resolve("rm-1")?.consignor?.commissionValue).toBe(25);
  });
  it("consignor GST status unknown is kept as unknown", () => {
    expect(resolve("rm-1")?.consignor?.gstRegistered).toBeNull();
  });
  it("longest prefix wins, and the explanation names it", () => {
    expect(resolve("RM-256549-001196-140526")?.acquiredFrom).toBe("private_seller");
    expect(resolve("RM-9")?.acquiredFrom).toBe("registered_supplier");
    const o = order({ lines: [{ ...line(order()), sku: "RM-9" }] });
    expect(classifyLine(o, line(o), resolve("RM-9")).explanation[0]).toBe('SKU prefix rule "RM-" (no individual record)');
  });
  it("manual override wins over every rule", () => {
    const us = order({ destinationCountry: "US", shippingProgram: "direct_export" });
    const r = classifyLine(us, line(us), owned({ overrideScenario: "A1" }));
    expect(r.scenario).toBe("A1");
    expect(r.explanation).toContain("manual override = A1");
  });
});

describe("shipping and refunds", () => {
  it("D2: domestic shipping is taxable, and lines + shipping add up", () => {
    const o = order({
      grossCents: 96500,
      shippingCents: 4595,
      lines: [
        { lineId: "a", sku: "A", title: "Stepdown", quantity: 1, grossCents: 6500, discountCents: 0 },
        { lineId: "b", sku: "B", title: "Wavestation", quantity: 1, grossCents: 85405, discountCents: 0 },
      ],
    });
    const out = classifyOrder(o, () => owned());
    expect(out).toHaveLength(3);
    expect(out[2]!.kind).toBe("shipping");
    expect(out.reduce((a, l) => a + l.grossCents, 0)).toBe(96500);
    expect(out[2]!.gstCents).toBe(gstInclusive(4595));
  });
  it("D2: shipping on an export is GST-free", () => {
    const o = order({ destinationCountry: "JP", shippingProgram: "direct_export", grossCents: 115000, shippingCents: 5000 });
    expect(classifyOrder(o, () => owned())[1]!.postings[0]!.taxCode).toBe("GST_FREE_EXPORT");
  });
  it("D2: shipping waits for review with its item, without a second issue", () => {
    const o = order({ grossCents: 115000, shippingCents: 5000 });
    const out = classifyOrder(o, () => null);
    expect(out[1]!.approval).toBe("review");
    expect(out[1]!.issues).toEqual([]);
  });
  it("D3: a refund reverses with the original scenario", () => {
    const refund = classifyOrder(rescaleOrder(order(), -55000), () => consigned());
    expect(refund[0]!.scenario).toBe("B1");
    expect(refund[0]!.grossCents).toBe(-55000);
    expect(refund[0]!.gstCents).toBe(-1000);
  });
});
