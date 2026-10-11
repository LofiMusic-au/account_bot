// Milestone 1 payout classification: the rules table, Division 66 status,
// and the review-queue facts (referred destinations, listing links).

import { describe, expect, it } from "vitest";
import { division66Status, FEE_CATEGORY_MAP, itemCategory, lineFacts, PAYOUT_CLASSIFICATION_RULES, baselineSplit } from "../src/accounting/baseline";
import worker, { ingestAndReport, rebuildStored, type Env } from "../src/index";
import { linkListing, makeResolver, referOrderDestination } from "../src/db";
import type { OrderSale, StockItem } from "../src/types";
import { ebayFixture, makeTestD1, seedFixtureFacts, shopifyFixture } from "./helpers";

const order = (over: Partial<OrderSale> = {}): OrderSale => ({
  orderId: "o",
  orderName: "#o",
  orderDate: "2026-10-01",
  destinationCountry: "AU",
  shippingProgram: "domestic",
  buyerCurrency: null,
  grossCents: 1000,
  lines: [{ lineId: "l", sku: "S", title: "t", quantity: 1, grossCents: 1000, discountCents: 0 }],
  shippingCents: 0,
  gateway: "x",
  sources: [],
  ...over,
});
const owned: StockItem = { sku: "S", ownership: "owned", source: "item" };
const consigned: StockItem = { sku: "S", ownership: "consignment", source: "item" };
const cat = (o: OrderSale, item: StockItem | null) => itemCategory(o, o.lines[0]!, () => item);

describe("the payout classification rules table", () => {
  it("has exactly these rows, in this order", () => {
    expect(PAYOUT_CLASSIFICATION_RULES.map((r) => [r.id, r.category])).toEqual([
      ["R1", "UNCLASSIFIED"],
      ["R2", "UNCLASSIFIED"],
      ["R3", "CONSIGNMENT_SALES_NO_GST"],
      ["R4", "UNCLASSIFIED"],
      ["R5", "SALES_OVERSEAS_NO_GST"],
      ["R6", "SALES_DOMESTIC_GST"],
    ]);
  });

  it("each row fires on its facts, first match wins", () => {
    const placeholder = order({ lines: [{ lineId: "l", sku: null, title: "t", quantity: 1, grossCents: 1000, discountCents: 0, placeholder: true }] });
    expect(cat(placeholder, owned).ruleId).toBe("R1");
    expect(cat(order(), null).ruleId).toBe("R2");
    expect(cat(order({ destinationCountry: "US", shippingProgram: "direct_export" }), consigned).ruleId).toBe("R3"); // consignment beats overseas
    expect(cat(order({ destinationCountry: null, shippingProgram: "unknown" }), consigned).ruleId).toBe("R3");
    expect(cat(order({ destinationCountry: null, shippingProgram: "unknown" }), owned).ruleId).toBe("R4");
    expect(cat(order({ destinationCountry: null, shippingProgram: "unknown", destinationReferred: true }), owned).ruleId).toBe("R4");
    expect(cat(order({ destinationCountry: "NZ", shippingProgram: "direct_export" }), owned).ruleId).toBe("R5");
    expect(cat(order({ destinationCountry: "DE", shippingProgram: "ebay_international" }), owned).reason).toMatch(/C2 still unresolved/);
    expect(cat(order(), owned)).toMatchObject({ ruleId: "R6", category: "SALES_DOMESTIC_GST" });
  });

  it("every combination of facts matches some row", () => {
    for (const orderDetailsMissing of [true, false])
      for (const ownership of ["owned", "consignment", null] as const)
        for (const destination of ["AU", "overseas", "unknown", "referred"] as const)
          for (const ebayInternationalShipping of [true, false])
            expect(PAYOUT_CLASSIFICATION_RULES.some((r) => r.test({ orderDetailsMissing, ownership, destination, ebayInternationalShipping }))).toBe(true);
  });

  it("fees map to a configured category for every fee type on both channels", () => {
    for (const ch of ["ebay", "shopify"] as const)
      for (const fc of ["marketplace", "payment", "advertising", "shipping_label", "other"] as const) expect(FEE_CATEGORY_MAP[ch][fc]).toMatch(/_FEES$/);
    expect(baselineSplit(ebayFixture(), () => null).lines.filter((l) => l.kind === "fee").every((l) => l.category === "EBAY_FEES")).toBe(true);
  });

  it("the facts the table sees", () => {
    expect(lineFacts(order({ destinationCountry: "au" }), order().lines[0]!, owned)).toEqual({
      orderDetailsMissing: false,
      ownership: "owned",
      destination: "AU",
      ebayInternationalShipping: false,
    });
  });
});

describe("Division 66 status: only assessed when acquisition facts exist", () => {
  it.each([
    [null, "not_assessed"],
    [consigned, "not_applicable"],
    [{ ...owned, acquiredFrom: null }, "not_assessed"],
    [{ ...owned, acquiredFrom: "registered_supplier" }, "not_applicable"],
    [{ ...owned, acquiredFrom: "other" }, "not_assessed"],
    [{ ...owned, acquiredFrom: "private_seller", condition: null }, "not_assessed"],
    [{ ...owned, acquiredFrom: "private_seller", condition: "new" }, "not_applicable"],
    [{ ...owned, acquiredFrom: "private_seller", condition: "secondhand" }, "candidate"],
    [{ ...owned, acquiredFrom: "trade_in", condition: "secondhand" }, "candidate"],
  ] as [StockItem | null, string][])("%o -> %s", (item, expected) => {
    expect(division66Status(item)).toBe(expected);
  });

  it("an L- item with no acquisition facts is Sales - GST but Division 66 not assessed", () => {
    const split = baselineSplit(shopifyFixture(), makeResolver([], [], []));
    expect(split.lines.find((l) => l.sku === "L-DISC-1")).toMatchObject({ category: "SALES_DOMESTIC_GST", ruleId: "R6", division66: "not_assessed" });
  });
});

describe("review-queue facts", () => {
  const env = (d1: D1Database) => ({ DB: d1 }) as unknown as Env;
  const post = (d1: D1Database, path: string, f: Record<string, string>) =>
    worker.fetch(new Request(`http://local${path}`, { method: "POST", body: new URLSearchParams(f) }), env(d1));

  it("destination unknown -> 'not sure' refers it to the accountant group instead of guessing", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    let r = await ingestAndReport(d1, shopifyFixture((f) => void (f.orders[1]!.shippingAddress = null)));
    expect(r.issues.some((i) => i.code === "unknown_destination")).toBe(true);
    const res = await post(d1, "/facts/order", { channel: "shopify", order_id: "gid://shopify/Order/3260", refer: "1", return: "/review" });
    expect(new URL(res.headers.get("Location")!, "http://x").searchParams.get("msg")).toMatch(/^Referred the destination for manual review/);
    r = (await rebuildStored(d1, "shopify", "9001"))!;
    expect(r.issues.find((i) => i.code === "destination_referred")).toMatchObject({ severity: "blocking" });
    expect(r.issues.some((i) => i.code === "unknown_destination")).toBe(false);
    expect(r.baseline!.lines.find((l) => l.sku === "L-DISC-1")!.ruleId).toBe("R4");
    const page = await (await worker.fetch(new Request("http://local/review"), env(d1))).text();
    expect(page.slice(page.lastIndexOf("<h2>For the accountant"))).toContain("Destination referred for review");
    // Answering it later replaces the referral.
    await referOrderDestination(d1, "shopify", "gid://shopify/Order/3260");
    await post(d1, "/facts/order", { channel: "shopify", order_id: "gid://shopify/Order/3260", country: "AU", return: "/review" });
    r = (await rebuildStored(d1, "shopify", "9001"))!;
    expect(r.status).toBe("ready");
  });

  it("a SKU-less eBay listing linked to a stock SKU is classified from that SKU, and the link persists", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    const noSku = () =>
      ebayFixture((f) => {
        const li = f.orders[0]!.lineItems[0]!;
        delete li.sku;
        li.legacyItemId = "555";
      });
    let r = await ingestAndReport(d1, noSku());
    expect(r.issues.find((i) => i.sku === "EBAY-ITEM-555")!.code).toBe("unknown_stock_record");
    const page = await (await worker.fetch(new Request("http://local/review"), env(d1))).text();
    expect(page).toContain("Link listing");

    await linkListing(d1, "ebay", "EBAY-ITEM-555", "L-500-A");
    r = (await rebuildStored(d1, "ebay", "7001"))!;
    const line = r.sales.find((l) => l.sku === "L-500-A")!;
    expect(line.scenario).toBe("A1");
    expect(line.explanation).toContain("listing EBAY-ITEM-555 linked by staff to stock SKU L-500-A");
    expect(r.status).toBe("ready");
    r = await ingestAndReport(d1, noSku()); // re-import keeps the link
    expect(r.sales.some((l) => l.sku === "L-500-A")).toBe(true);
    await expect(linkListing(d1, "ebay", "EBAY-ITEM-555", " ")).rejects.toThrow(/Enter the stock SKU/);
  });

  it("the Rules page lists the table", async () => {
    const { d1 } = makeTestD1();
    const html = await (await worker.fetch(new Request("http://local/rules"), env(d1))).text();
    for (const id of ["R1", "R2", "R3", "R4", "R5", "R6"]) expect(html).toContain(`<b>${id}</b>`);
    expect(html).toContain("Overseas Sales - No GST");
  });
});
