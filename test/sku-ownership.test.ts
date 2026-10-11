// LOFI's SKU ownership conventions: pinned. These feed ownership ->
// payout classification -> GST bucket -> QuickBooks journal.

import { describe, expect, it } from "vitest";
import { SKU_OWNERSHIP_RULES, skuOwnershipRule } from "../src/rules/sku-ownership";
import { linkListing, makeResolver, type StockRow } from "../src/db";
import { baselineSplit, division66Status } from "../src/accounting/baseline";
import { ingestAndReport, rebuildStored } from "../src/index";
import { ebayFixture, makeTestD1, seedFixtureFacts, shopifyFixture } from "./helpers";

const resolve = makeResolver([], [], []);
const own = (sku: string) => resolve(sku)?.ownership ?? null;
const rule = (sku: string) => resolve(sku)?.ruleId ?? null;

describe("the conventions table", () => {
  it("has exactly these rules, in this order", () => {
    expect(SKU_OWNERSHIP_RULES.map((r) => [r.prefix, r.ownership])).toEqual([
      ["L", "owned"],
      ["M_C", "consignment"],
      ["A_C", "consignment"],
      ["insdot", "consignment"],
      ["INS", "consignment"],
      ["audot", "consignment"],
      ["AUD", "consignment"],
      ["RM", "consignment"],
      ["TT", "consignment"],
      ["P", "consignment"],
      ["G", "consignment"],
      ["BOX", "consignment"],
      ["OWN-BOX", "consignment"],
      ["OWNBOX", "consignment"],
    ]);
  });
});

describe("LOFI-owned", () => {
  it.each(["L-123", "L-zn41902-170926", "l-lower-1", "L123", "LOFI-x"])("%s -> LOFI-owned (sku_rule:L_PREFIX)", (sku) => {
    expect(own(sku)).toBe("owned");
    expect(rule(sku)).toBe("sku_rule:L_PREFIX");
  });
});

describe("consignment", () => {
  it.each([
    ["M_C-001", "sku_rule:M_C_PREFIX"],
    ["m_c-002", "sku_rule:M_C_PREFIX"],
    ["A_C-77", "sku_rule:A_C_PREFIX"],
    ["INS_220630_00038", "sku_rule:INS_PREFIX"],
    ["ins-5", "sku_rule:INS_PREFIX"],
    ["insdot-12", "sku_rule:INSDOT_PREFIX"],
    ["INSDOT-12", "sku_rule:INSDOT_PREFIX"],
    ["AUD_220620_00037", "sku_rule:AUD_PREFIX"],
    ["aud-9", "sku_rule:AUD_PREFIX"],
    ["audot-3", "sku_rule:AUDOT_PREFIX"],
    ["RM-256549-001196-140526", "sku_rule:RM_PREFIX"],
    ["TT-BOX62-1", "sku_rule:TT_PREFIX"],
    ["P41-ZD05714-270826", "sku_rule:P_PREFIX"],
    ["G50-UD80m-31826", "sku_rule:G_PREFIX"],
    ["BOX-17", "sku_rule:BOX_PREFIX"],
    ["OWNBOX-134416-201125", "sku_rule:OWNBOX_PREFIX"],
    ["ownbox-134416-201125", "sku_rule:OWNBOX_PREFIX"],
    ["Ownbox-3055152-201125", "sku_rule:OWNBOX_PREFIX"],
    ["OWN-BOX-5", "sku_rule:OWN-BOX_PREFIX"],
  ])("%s -> consignment (%s)", (sku, id) => {
    expect(own(sku)).toBe("consignment");
    expect(rule(sku)).toBe(id);
  });
});

describe("no rule -> review (individual examples are not generalised)", () => {
  it.each(["OK-3)AUD_210704_00054", "Stand-1-3094830-31025", "3095377-ownbox-genstylus-31025", "3095368-ownbox-shurestyl-31025", "240/100_Stepdown", "Yamaha-cmxiikit", "100926", ""])(
    "%s -> unknown",
    (sku) => {
      expect(resolve(sku || null)).toBeNull();
    },
  );
});

describe("ownership only", () => {
  it("never sets the acquisition source, condition, price or consignor, so no Division 66 eligibility", () => {
    for (const sku of ["L-1", "RM-1", "OWNBOX-1"]) {
      const item = resolve(sku)!;
      expect(item).toMatchObject({ source: "convention", acquiredFrom: null, condition: null, purchaseCents: null, consignor: null });
      expect(item.commissionType ?? null).toBeNull();
    }
    expect(division66Status(resolve("L-1"))).toBe("not_assessed");
  });

  it("a consignment SKU still needs its consignor before the sale is classified (R3), and the explanation names the rule", () => {
    const split = baselineSplit(shopifyFixture((f) => void (f.orders[1]!.lineItems.nodes[0]!.sku = "OWNBOX-777")), resolve);
    const line = split.lines.find((l) => l.sku === "OWNBOX-777")!;
    expect(line).toMatchObject({ category: "UNCLASSIFIED", ruleId: "R3" });
  });
});

describe("precedence", () => {
  const row = (sku: string, ownership: "owned" | "consignment"): StockRow => ({
    sku, title: null, ownership, acquired_from: null, purchase_cents: null, purchase_date: null, seller_name: null, seller_address: null,
    seller_description: null, consignor_id: null, commission_type: null, commission_value: null, override_scenario: null,
  });

  it("1. an explicit stock record beats a conflicting convention", () => {
    const r = makeResolver([row("P41-ZD05714-270826", "owned"), row("L-ODD-1", "consignment")], [], []);
    expect(r("P41-ZD05714-270826")).toMatchObject({ ownership: "owned", source: "item" });
    expect(r("L-ODD-1")).toMatchObject({ ownership: "consignment", source: "item" });
  });

  it("3. a staff prefix rule beats a built-in convention", () => {
    const r = makeResolver([], [{ prefix: "P9", ownership: "owned", acquired_from: null, consignor_id: null, commission_type: null, commission_value: null }], []);
    expect(r("P9-123")).toMatchObject({ ownership: "owned", source: "prefix" });
    expect(r("P8-123")).toMatchObject({ ownership: "consignment", source: "convention" });
  });

  it("2. a persisted listing -> SKU link resolves before any convention, through the linked SKU", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    const noSku = () =>
      ebayFixture((f) => {
        const li = f.orders[0]!.lineItems[0]!;
        delete li.sku;
        li.legacyItemId = "4242";
      });
    await ingestAndReport(d1, noSku());
    // The listing key itself would match no convention; linked to an L- SKU it is LOFI-owned via that SKU.
    await linkListing(d1, "ebay", "EBAY-ITEM-4242", "L-NEW-LINKED");
    const r = (await rebuildStored(d1, "ebay", "7001"))!;
    const line = r.sales.find((l) => l.sku === "L-NEW-LINKED")!;
    expect(line.explanation).toContain("listing EBAY-ITEM-4242 linked by staff to stock SKU L-NEW-LINKED");
    expect(r.baseline!.lines.find((l) => l.sku === "L-NEW-LINKED")!.category).toBe("SALES_DOMESTIC_GST");
  });

  it("5. no record, no rule, no convention -> review", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    sqlite.prepare("DELETE FROM stock_items WHERE sku = '240/100_Stepdown'").run();
    const r = await ingestAndReport(d1, shopifyFixture());
    expect(r.issues.find((i) => i.sku === "240/100_Stepdown")!.code).toBe("unknown_stock_record");
  });
});

it("the conventions table is shown on the Rules page", async () => {
  const worker = (await import("../src/index")).default;
  const { d1 } = makeTestD1();
  const html = await (await worker.fetch(new Request("http://local/rules"), { DB: d1 } as never)).text();
  for (const r of SKU_OWNERSHIP_RULES) expect(html).toContain(r.id);
  expect(skuOwnershipRule("ownbox-1")!.id).toBe("sku_rule:OWNBOX_PREFIX");
});
