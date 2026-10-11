// The review queue as a fact-correction console: multi-fact saves, safe SKU
// prefix rules, grouping, and "this made a payout ready" feedback.

import { describe, expect, it } from "vitest";
import worker, { ingestAndReport, type Env } from "../src/index";
import { savePrefixRule, saveStockFacts } from "../src/db";
import { issueGroup, suggestPrefix } from "../src/ui";
import { makeTestD1, seedFixtureFacts, shopifyFixture } from "./helpers";

const env = (d1: D1Database): Env =>
  ({ DB: d1, SHOPIFY_SHOP: "x", SHOPIFY_API_VERSION: "2026-10", EBAY_MARKETPLACE_ID: "EBAY_AU", LOOKBACK_DAYS: "14" }) as Env;
const post = (path: string, fields: Record<string, string>) =>
  new Request(`http://local${path}`, { method: "POST", body: new URLSearchParams(fields) });
const msgOf = (res: Response) => decodeURIComponent(new URL(res.headers.get("Location")!, "http://local").searchParams.get("msg") ?? "");

describe("helpers", () => {
  it("suggests a prefix up to the first separator", () => {
    expect(suggestPrefix("L-zn41902-170926")).toBe("L-");
    expect(suggestPrefix("RM-256549-001196-140526")).toBe("RM-");
    expect(suggestPrefix("240/100_Stepdown")).toBe("240/");
    expect(suggestPrefix("Cable")).toBe("");
  });
  it("groups issues into facts, integration and accounting", () => {
    expect(issueGroup({ code: "unknown_stock_record", severity: "blocking", message: "" })).toBe("facts");
    expect(issueGroup({ code: "unknown_destination", severity: "blocking", message: "" })).toBe("facts");
    expect(issueGroup({ code: "order_details_missing", severity: "blocking", message: "" })).toBe("integration");
    expect(issueGroup({ code: "unsupported_transaction_type", severity: "blocking", message: "" })).toBe("integration");
    expect(issueGroup({ code: "unresolved_scenario", severity: "blocking", message: "" })).toBe("accounting");
    expect(issueGroup({ code: "dispute", severity: "blocking", message: "" })).toBe("accounting");
  });
});

describe("saving several facts at once", () => {
  it("creates a record with ownership, source, condition and price, then edits without losing fields", async () => {
    const { d1, sqlite } = makeTestD1();
    await saveStockFacts(d1, "L-NEW-1", { ownership: "owned", acquired_from: "private_seller", item_condition: "secondhand", purchase_cents: 45000 }, "Juno-106");
    await saveStockFacts(d1, "l-new-1", { item_condition: "new" });
    expect(sqlite.prepare("SELECT ownership, acquired_from, item_condition, purchase_cents, title FROM stock_items").get()).toEqual({
      ownership: "owned",
      acquired_from: "private_seller",
      item_condition: "new",
      purchase_cents: 45000,
      title: "Juno-106",
    });
  });
  it("switching to consignment clears the acquisition source; refuses contradictions", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    await saveStockFacts(d1, "L-NEW-2", { ownership: "owned", acquired_from: "trade_in" });
    await saveStockFacts(d1, "L-NEW-2", { ownership: "consignment", consignor_id: 1, commission_value: 20 });
    expect(sqlite.prepare("SELECT ownership, acquired_from, consignor_id, commission_value FROM stock_items WHERE sku = 'L-NEW-2'").get()).toEqual({
      ownership: "consignment",
      acquired_from: null,
      consignor_id: 1,
      commission_value: 20,
    });
    await expect(saveStockFacts(d1, "X", { ownership: "owned", consignor_id: 1 })).rejects.toThrow(/can't have a consignor/);
    await expect(saveStockFacts(d1, "Y", { item_condition: "new" })).rejects.toThrow(/LOFI-owned or consignment first/);
    await expect(saveStockFacts(d1, "Z", { ownership: "owned", commission_value: 120 })).rejects.toThrow(/between 0 and 100/);
  });
});

describe("safe SKU prefix rules", () => {
  it("must be at least 2 characters and the start of the SKU it came from", async () => {
    const { d1 } = makeTestD1();
    await expect(savePrefixRule(d1, { prefix: "L", ownership: "owned" }, "L-1")).rejects.toThrow(/at least 2/);
    await expect(savePrefixRule(d1, { prefix: "RM-", ownership: "owned" }, "L-1")).rejects.toThrow(/isn't the start/);
    expect(await savePrefixRule(d1, { prefix: "L-", ownership: "owned", acquired_from: "registered_supplier" }, "L-1")).toBe("created");
  });
  it("won't overwrite an existing rule unless asked", async () => {
    const { d1, sqlite } = makeTestD1();
    await savePrefixRule(d1, { prefix: "L-", ownership: "owned", acquired_from: "registered_supplier" }, "L-1");
    await expect(savePrefixRule(d1, { prefix: "l-", ownership: "owned", acquired_from: "private_seller" }, "L-2")).rejects.toThrow(/already exists/);
    expect(await savePrefixRule(d1, { prefix: "L-", ownership: "owned", acquired_from: "private_seller" }, "L-2", true)).toBe("replaced");
    expect(sqlite.prepare("SELECT acquired_from FROM sku_prefix_rules").all()).toEqual([{ acquired_from: "private_seller" }]);
  });
});

describe("review queue end to end (through the Worker)", () => {
  it("one form save records facts, makes a payout ready and says so", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    sqlite.prepare("DELETE FROM stock_items WHERE sku = 'L-DISC-1'").run();
    await ingestAndReport(d1, shopifyFixture());

    const page = await (await worker.fetch(new Request("http://local/review"), env(d1))).text();
    expect(page).toContain("Facts to record");
    expect(page).toContain("L-DISC-1");
    expect(page).toContain("Fixing this makes 1 payout ready");
    expect(page).toMatch(/Make a rule for SKUs starting with <input name="prefix" value="L-"/);

    const res = await worker.fetch(
      post("/facts/item", { sku: "L-DISC-1", title: "Digitakt", ownership: "owned", acquired_from: "registered_supplier", item_condition: "new", return: "/review" }),
      env(d1),
    );
    expect(res.status).toBe(303);
    expect(msgOf(res)).toMatch(/Saved L-DISC-1\. Now ready \(provisional\): Shopify 2026-10-08 \(9001\)\. 0 payout\(s\) still need review\./);
  });

  it("the form can also create a prefix rule, and errors come back as a message", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    sqlite.prepare("DELETE FROM stock_items WHERE sku = 'L-DISC-1'").run();
    await ingestAndReport(d1, shopifyFixture());
    const ok = await worker.fetch(
      post("/facts/item", { sku: "L-DISC-1", ownership: "owned", acquired_from: "registered_supplier", make_prefix: "1", prefix: "L-", return: "/review" }),
      env(d1),
    );
    expect(msgOf(ok)).toMatch(/created the rule for SKUs starting with "L-"/);
    expect(sqlite.prepare("SELECT prefix, ownership, acquired_from FROM sku_prefix_rules").all()).toEqual([
      { prefix: "L-", ownership: "owned", acquired_from: "registered_supplier" },
    ]);
    const bad = await worker.fetch(post("/facts/item", { sku: "L-DISC-1", make_prefix: "1", prefix: "L-", return: "/review" }), env(d1));
    expect(msgOf(bad)).toMatch(/^Not saved: Choose ownership/);
  });
});
