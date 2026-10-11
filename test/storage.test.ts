// Storage tests over the real migrations: idempotent re-import, provenance,
// and staff fact corrections flowing through to the report.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ingestAndReport, rebuildStored } from "../src/index";
import { clearPayouts, addConsignor, setConsignorAgreement, setConsignorGst, setOrderDestination, setStockFact, getReport } from "../src/db";
import { applyMigrations, ebayFixture, makeTestD1, migrationFiles, newSqlite, seedFixtureFacts, shopifyFixture } from "./helpers";

const count = (sqlite: ReturnType<typeof makeTestD1>["sqlite"], table: string) =>
  (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const strip = (r: object) => ({ ...r, generatedAt: "" });

describe("idempotent re-import", () => {
  it("re-fetching the same payout creates no duplicate records", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    const first = await ingestAndReport(d1, ebayFixture());
    const second = await ingestAndReport(d1, ebayFixture());
    expect(count(sqlite, "source_payouts")).toBe(1);
    expect(count(sqlite, "source_transactions")).toBe(7);
    expect(count(sqlite, "source_orders")).toBe(4);
    expect(count(sqlite, "payout_reports")).toBe(1);
    expect(strip(second)).toEqual(strip(first));
    const p = sqlite.prepare("SELECT fetch_count FROM source_payouts").get() as { fetch_count: number };
    const r = sqlite.prepare("SELECT run_count, status, provisional FROM payout_reports").get() as Record<string, unknown>;
    expect(p.fetch_count).toBe(2);
    expect(r).toMatchObject({ run_count: 2, status: "ready", provisional: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM source_transactions WHERE changed_at IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("stores provenance: raw amounts, IDs, timestamps, payloads without buyer details", async () => {
    const { d1, sqlite } = makeTestD1();
    await ingestAndReport(d1, ebayFixture());
    const row = sqlite
      .prepare("SELECT * FROM source_transactions WHERE transaction_id = '26-00001-00001'")
      .get() as Record<string, string>;
    expect(row).toMatchObject({ channel: "ebay", transaction_type: "SALE", payout_id: "7001", order_id: "26-00001-00001", raw_amount: "736.88", raw_currency: "AUD", source_timestamp: "2026-10-06T01:00:00.000Z" });
    expect(row.first_ingested_at).toBeTruthy();
    expect(row.payload_json!).not.toContain("some_buyer");
    expect(JSON.parse(row.payload_json!).totalFeeAmount.value).toBe("83.12");
  });

  it("flags a re-fetch that changed a transaction", async () => {
    const { d1, sqlite } = makeTestD1();
    await ingestAndReport(d1, ebayFixture());
    await ingestAndReport(d1, ebayFixture((f) => void (f.transactions[4]!.transactionMemo = "changed")));
    expect(sqlite.prepare("SELECT transaction_id FROM source_transactions WHERE changed_at IS NOT NULL").all()).toEqual([{ transaction_id: "AD-8800" }]);
  });

  it("a transaction already in another payout blocks instead of being counted twice", async () => {
    const { d1, sqlite } = makeTestD1();
    await ingestAndReport(d1, ebayFixture());
    const r = await ingestAndReport(d1, ebayFixture((f) => void (f.payout.payoutId = "7002")));
    expect(r.issues.filter((i) => i.code === "transaction_in_other_payout")).toHaveLength(7);
    expect(r.status).toBe("needs_review");
    // The original rows keep their payout.
    expect(sqlite.prepare("SELECT DISTINCT payout_id FROM source_transactions").all()).toEqual([{ payout_id: "7001" }]);
    // And the issue survives a rebuild from stored data.
    expect((await rebuildStored(d1, "ebay", "7002"))!.issues.some((i) => i.code === "transaction_in_other_payout")).toBe(true);
  });
});

describe("staff correct facts, not tax codes", () => {
  it("an L- SKU with no record: owned by convention; the missing source is deferred, so the payout is ready", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    sqlite.prepare("DELETE FROM stock_items WHERE sku = 'L-DISC-1'").run();
    const r = await ingestAndReport(d1, shopifyFixture());
    expect(r.issues.filter((i) => i.severity === "blocking")).toEqual([]);
    expect(r.issues.filter((i) => i.severity === "deferred").map((i) => i.code)).toEqual(["unknown_acquisition_source"]);
    expect(r.status).toBe("ready");
    expect(r.sales.find((l) => l.sku === "L-DISC-1")!.explanation[0]).toBe('SKU convention "L-" = LOFI-owned (no individual record)');
  });

  it("unknown non-L SKU -> ownership -> ready", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    sqlite.prepare("DELETE FROM stock_items WHERE sku = '240/100_Stepdown'").run();
    let r = await ingestAndReport(d1, shopifyFixture());
    expect(r.issues.filter((i) => i.severity === "blocking").map((i) => i.code)).toEqual(["unknown_stock_record"]);
    await setStockFact(d1, "240/100_Stepdown", "ownership", "owned", "Stepdown");
    r = (await rebuildStored(d1, "shopify", "9001"))!;
    expect(r.status).toBe("ready");
    await setStockFact(d1, "240/100_Stepdown", "acquired_from", "registered_supplier");
    r = (await rebuildStored(d1, "shopify", "9001"))!;
    expect(r.sales.find((l) => l.sku === "240/100_Stepdown")!.scenario).toBe("A1");
    expect((await getReport(d1, "shopify", "9001"))!.status).toBe("ready");
  });

  it("a fact can't be set before ownership is known", async () => {
    const { d1 } = makeTestD1();
    await expect(setStockFact(d1, "NEW-1", "acquired_from", "trade_in")).rejects.toThrow(/LOFI-owned or consignment first/);
    await expect(setStockFact(d1, "NEW-1", "ownership", "mine")).rejects.toThrow();
  });

  it("consignor GST status unknown -> recorded -> classified", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    sqlite.prepare("UPDATE consignors SET australian_gst_registered = NULL, australian_gst_basis = NULL").run();
    let r = await ingestAndReport(d1, shopifyFixture());
    expect(r.issues.find((i) => i.code === "unknown_consignor_gst_status")).toMatchObject({ consignorId: 1 });
    await setConsignorGst(d1, 1, false);
    r = (await rebuildStored(d1, "shopify", "9001"))!;
    expect(r.sales.find((l) => l.sku === "RM-256549-001196-140526")!.scenario).toBe("B1");
  });

  it("destination recorded by staff for an order without one", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    let r = await ingestAndReport(d1, shopifyFixture((f) => void (f.orders[1]!.shippingAddress = null)));
    expect(r.issues.some((i) => i.code === "unknown_destination")).toBe(true);
    await setOrderDestination(d1, "shopify", "gid://shopify/Order/3260", "au");
    r = (await rebuildStored(d1, "shopify", "9001"))!;
    const l = r.sales.find((x) => x.sku === "L-DISC-1")!;
    expect(l.scenario).toBe("A1");
    expect(l.explanation).toContain("destination = AU (recorded by staff)");
    expect(r.status).toBe("ready");
  });
});

describe("milestone 1 can't write to QuickBooks", () => {
  it("has no QuickBooks client and only calls eBay and Shopify", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e: import("node:fs").Dirent) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const src = files(join(import.meta.dirname, "../src")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src).not.toMatch(/intuit\.com|quickbooks\.api|oauth\.platform\.intuit/i);
    const hosts = [...src.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
    expect(new Set(hosts.filter((h) => !h.endsWith("ebay.com")))).toEqual(new Set());
  });
});

describe("consignor facts", () => {
  it("migration 0003 keeps GST answers, resets agreement types to unknown and keeps stock links", () => {
    const sqlite = newSqlite();
    const files = migrationFiles();
    applyMigrations(sqlite, files.filter((f) => f < "0003"));
    sqlite.prepare("INSERT INTO consignors (id, name, gst_registered, gst_status, agreement_type) VALUES (5, 'Reg', 1, 'registered', 'agency')").run();
    sqlite.prepare("INSERT INTO consignors (id, name, gst_registered, gst_status, agreement_type) VALUES (6, 'Unknown', 0, NULL, 'agency')").run();
    sqlite.prepare("INSERT INTO stock_items (sku, ownership, consignor_id) VALUES ('C-1', 'consignment', 5)").run();
    applyMigrations(sqlite, files.filter((f) => f >= "0003"));
    expect(sqlite.prepare("SELECT id, australian_gst_registered, australian_gst_basis, agreement_type FROM consignors ORDER BY id").all()).toEqual([
      { id: 5, australian_gst_registered: 1, australian_gst_basis: "recorded", agreement_type: null },
      { id: 6, australian_gst_registered: null, australian_gst_basis: null, agreement_type: null },
    ]);
    expect(sqlite.prepare("SELECT c.name FROM stock_items s JOIN consignors c ON c.id = s.consignor_id").get()).toEqual({ name: "Reg" });
    // A new consignor gets no agreement by default.
    sqlite.prepare("INSERT INTO consignors (name) VALUES ('New')").run();
    expect(sqlite.prepare("SELECT agreement_type, australian_gst_registered FROM consignors WHERE name = 'New'").get()).toEqual({
      agreement_type: null,
      australian_gst_registered: null,
    });
  });

  it("an overseas consignor added at intake defaults to not registered for Australian GST, and sales go to B1", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    const id = await addConsignor(d1, { name: "Tokyo seller", country: "jp", australian_gst_registered: "auto", commission_value: 20 });
    expect(sqlite.prepare("SELECT country, australian_gst_registered, australian_gst_basis, agreement_type FROM consignors WHERE id = ?").get(id)).toEqual({
      country: "JP",
      australian_gst_registered: 0,
      australian_gst_basis: "intake_default_overseas",
      agreement_type: null,
    });
    sqlite.prepare("UPDATE stock_items SET consignor_id = ? WHERE sku = 'RM-256549-001196-140526'").run(id);
    const r = await ingestAndReport(d1, shopifyFixture());
    const l = r.sales.find((x) => x.sku === "RM-256549-001196-140526")!;
    expect(l.scenario).toBe("B1");
    expect(l.explanation).toContain("australian_gst_registered = no (intake default for an overseas consignor)");
    expect(l.explanation).toContain("agreement = not recorded (not needed for a non-registered consignor)");
  });

  it("an Australian consignor added at intake is asked, not defaulted", async () => {
    const { d1, sqlite } = makeTestD1();
    const id = await addConsignor(d1, { name: "Sydney seller", country: "AU" });
    expect(sqlite.prepare("SELECT australian_gst_registered FROM consignors WHERE id = ?").get(id)).toEqual({ australian_gst_registered: null });
  });

  it("a GST-registered consignor goes to manual review; correcting the fact to not registered resolves it", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    await setConsignorGst(d1, 1, true);
    let r = await ingestAndReport(d1, shopifyFixture());
    expect(r.issues.find((i) => i.code === "registered_consignor")).toMatchObject({ consignorId: 1, severity: "blocking" });
    expect(r.status).toBe("needs_review");
    await setConsignorAgreement(d1, 1, "agency"); // no agreement pathway is automated
    r = (await rebuildStored(d1, "shopify", "9001"))!;
    expect(r.status).toBe("needs_review");
    await setConsignorGst(d1, 1, false);
    r = (await rebuildStored(d1, "shopify", "9001"))!;
    expect(r.sales.find((x) => x.sku === "RM-256549-001196-140526")!.scenario).toBe("B1");
    expect(r.status).toBe("ready");
  });
});

describe("clear all payouts", () => {
  it("removes reports and source data, keeps stock, consignors and facts", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    await ingestAndReport(d1, ebayFixture());
    await ingestAndReport(d1, shopifyFixture());
    await setOrderDestination(d1, "shopify", "gid://shopify/Order/3260", "AU");
    expect(await clearPayouts(d1)).toBe(2);
    for (const t of ["payout_reports", "source_payouts", "source_transactions", "source_orders"]) expect(count(sqlite, t)).toBe(0);
    expect(count(sqlite, "stock_items")).toBeGreaterThan(0);
    expect(count(sqlite, "consignors")).toBe(1);
    expect(count(sqlite, "order_facts")).toBe(1);
    // Fetching again works normally.
    expect((await ingestAndReport(d1, ebayFixture())).differenceCents).toBe(0);
  });
});
