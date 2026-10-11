// Historical accounting baseline: stage 1 (payout split by logical category)
// and stage 2 (consignment subledger). These assert LOFI's current manual
// method, captured as the operational baseline, not accountant-approved law.

import { describe, expect, it } from "vitest";
import { baselineSplit } from "../src/accounting/baseline";
import { calculateCommission, consignmentEntries, periodTotals } from "../src/accounting/consignment";
import { makeResolver } from "../src/db";
import { gstInclusive } from "../src/money";
import { buildReport } from "../src/reconcile";
import { ingestAndReport, rebuildStored } from "../src/index";
import { ebayFixture, fixtureResolver, makeTestD1, seedFixtureFacts, shopifyFixture } from "./helpers";

const resolve = fixtureResolver();

describe("stage 1: payout split by logical category", () => {
  const shop = baselineSplit(shopifyFixture(), resolve);
  const cat = (sku: string) => shop.lines.find((l) => l.sku === sku && l.kind === "item")!.category;

  it("LOFI-owned domestic sale -> SALES_DOMESTIC_GST", () => {
    expect(cat("240/100_Stepdown")).toBe("SALES_DOMESTIC_GST");
    expect(cat("L-DISC-1")).toBe("SALES_DOMESTIC_GST");
  });

  it("LOFI-owned overseas sale -> SALES_OVERSEAS_NO_GST", () => {
    expect(cat("L-NZ-2")).toBe("SALES_OVERSEAS_NO_GST");
  });

  it("consignment sale -> CONSIGNMENT_SALES_NO_GST for the full sale amount", () => {
    const l = shop.lines.find((x) => x.sku === "RM-256549-001196-140526")!;
    expect(l.category).toBe("CONSIGNMENT_SALES_NO_GST");
    expect(l.cents).toBe(85405);
  });

  it("fees, refunds and adjustments; the split adds up to the payout", () => {
    expect(shop.totals.SHOPIFY_FEES).toBe(-7684);
    expect(shop.totals.MARKETPLACE_ADJUSTMENTS).toBe(-200);
    const refunds = shop.lines.filter((l) => l.kind === "refund");
    expect(refunds.every((l) => l.category === "REFUND" && l.reversesCategory === "SALES_DOMESTIC_GST")).toBe(true);
    expect(refunds.reduce((a, l) => a + l.cents, 0)).toBe(-10000);
    expect(shop.sumCents).toBe(172616);
    expect(shop.complete).toBe(true);
    const ebay = baselineSplit(ebayFixture(), resolve);
    expect(ebay.sumCents).toBe(174338);
    expect(ebay.totals.EBAY_FEES).toBe(-27162);
  });

  it("is part of the payout report and doesn't depend on GST scenario facts", () => {
    // Owned by the L- convention only (no source recorded): the draft GST
    // scenario needs review, but the historical split is still known.
    const r = buildReport(shopifyFixture(), makeResolver([], [], []));
    const l = r.baseline!.lines.find((x) => x.sku === "L-DISC-1")!;
    expect(l.category).toBe("SALES_DOMESTIC_GST");
    expect(r.sales.find((x) => x.sku === "L-DISC-1")!.scenario).toBe("REVIEW");
  });

  it("missing facts give UNCLASSIFIED, never a guess", () => {
    const r = baselineSplit(shopifyFixture((f) => void (f.orders[1]!.shippingAddress = null)), makeResolver([], [], []));
    expect(r.lines.find((x) => x.sku === "240/100_Stepdown")!.category).toBe("UNCLASSIFIED"); // no record, not L-
    expect(r.lines.find((x) => x.sku === "L-DISC-1")!.category).toBe("UNCLASSIFIED"); // destination unknown
    expect(r.complete).toBe(false);
    expect(r.sumCents).toBe(172616); // still adds up
  });

  it("shipping on a mixed order is shared across its item categories", () => {
    const ship = shop.lines.filter((l) => l.kind === "shipping" && l.orderId === "gid://shopify/Order/3252");
    expect(ship.map((l) => l.category).sort()).toEqual(["CONSIGNMENT_SALES_NO_GST", "SALES_DOMESTIC_GST"]);
    expect(ship.reduce((a, l) => a + l.cents, 0)).toBe(4595);
  });
});

describe("stage 2: consignment commission calculation", () => {
  it("percentage commission", () => {
    expect(calculateCommission(110000, 1, { type: "percent", value: 20 })).toEqual({
      commissionCents: 22000,
      commissionGstCents: 2000,
      consignorPayableCents: 88000,
    });
    expect(calculateCommission(85405, 1, { type: "percent", value: 25 }).commissionCents).toBe(21351);
    expect(calculateCommission(10000, 1, { type: "percent", value: 12.5 }).commissionCents).toBe(1250);
  });

  it("fixed-dollar commission, per unit, never more than the sale", () => {
    expect(calculateCommission(100000, 2, { type: "fixed", value: 150 })).toEqual({
      commissionCents: 30000,
      commissionGstCents: gstInclusive(30000),
      consignorPayableCents: 70000,
    });
    expect(calculateCommission(5000, 1, { type: "fixed", value: 150 }).commissionCents).toBe(5000);
  });

  it("consignor payable = sale basis - LOFI commission; refunds reverse it", () => {
    for (const [basis, rule] of [
      [123456, { type: "percent", value: 17.5 }],
      [99999, { type: "fixed", value: 33.33 }],
    ] as const) {
      const c = calculateCommission(basis, 1, rule);
      expect(c.consignorPayableCents + c.commissionCents).toBe(basis);
    }
    const refund = calculateCommission(-110000, 1, { type: "percent", value: 20 });
    expect(refund).toEqual({ commissionCents: -22000, commissionGstCents: -2000, consignorPayableCents: -88000 });
  });

  it("the same consignment sale appears in the subledger, with commission GST kept separate", () => {
    const payout = shopifyFixture();
    const entries = consignmentEntries(payout, resolve);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e).toMatchObject({
      sku: "RM-256549-001196-140526",
      kind: "sale",
      grossSaleCents: 85405,
      commissionCents: 21351,
      commissionGstCents: 1941,
      consignorPayableCents: 64054,
      accountingPeriod: "2026-10",
      status: "calculated",
    });
    // The payout-stage line carries no GST: commission GST lives only in the ledger.
    const split = baselineSplit(payout, resolve);
    const line = split.lines.find((l) => l.sku === e.sku)!;
    expect(line.category).toBe("CONSIGNMENT_SALES_NO_GST");
    expect(line.cents).toBe(e.grossSaleCents);
    expect(Object.keys(line)).not.toContain("gstCents");
  });

  it("an entry with no consignor or rule is kept as incomplete and left out of the totals", () => {
    const r = makeResolver(
      [{ sku: "C-1", title: null, ownership: "consignment", acquired_from: null, purchase_cents: null, purchase_date: null, seller_name: null, seller_address: null, seller_description: null, consignor_id: null, commission_type: null, commission_value: null, override_scenario: null }],
      [],
      [],
    );
    const payout = shopifyFixture((f) => void (f.orders[0]!.lineItems.nodes[1]!.sku = "C-1"));
    const e = consignmentEntries(payout, r);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ status: "incomplete", problem: "No consignor recorded", commissionCents: null });
    expect(periodTotals(e)[0]).toMatchObject({ entries: 1, incomplete: 1, commissionCents: 0 });
  });
});

describe("stage 2: the subledger in the database", () => {
  const ledger = (sqlite: ReturnType<typeof makeTestD1>["sqlite"]) =>
    sqlite.prepare("SELECT entry_key, kind, gross_sale_cents, commission_cents, commission_gst_cents, consignor_payable_cents, journal_status FROM consignment_sales ORDER BY entry_key").all() as Record<string, unknown>[];

  it("is fed automatically by ingest, and re-import doesn't duplicate entries", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    await ingestAndReport(d1, shopifyFixture());
    await ingestAndReport(d1, ebayFixture());
    const first = ledger(sqlite);
    expect(first.map((x) => x.gross_sale_cents)).toEqual(expect.arrayContaining([85405, 110000]));
    expect(first).toHaveLength(2);
    await ingestAndReport(d1, shopifyFixture());
    await ingestAndReport(d1, ebayFixture());
    await rebuildStored(d1, "shopify", "9001");
    expect(ledger(sqlite)).toEqual(first);
  });

  it("changing a consignor's rule recalculates unposted entries but never alters the source sale", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    await ingestAndReport(d1, shopifyFixture());
    const sourceBefore = sqlite.prepare("SELECT transaction_id, raw_amount, payload_hash FROM source_transactions ORDER BY transaction_id").all();
    const stored = sqlite.prepare("SELECT normalised_json FROM source_payouts").get();

    sqlite.prepare("UPDATE consignors SET commission_value = 30 WHERE id = 1").run();
    await rebuildStored(d1, "shopify", "9001");

    expect(sqlite.prepare("SELECT transaction_id, raw_amount, payload_hash FROM source_transactions ORDER BY transaction_id").all()).toEqual(sourceBefore);
    expect(sqlite.prepare("SELECT normalised_json FROM source_payouts").get()).toEqual(stored);
    expect(ledger(sqlite)[0]).toMatchObject({ gross_sale_cents: 85405, commission_cents: 25622, consignor_payable_cents: 59783 });
  });

  it("posted entries are frozen: a later rule change or re-import leaves them alone", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    await ingestAndReport(d1, shopifyFixture());
    sqlite.prepare("UPDATE consignment_sales SET journal_status = 'posted'").run();
    sqlite.prepare("UPDATE consignors SET commission_value = 50 WHERE id = 1").run();
    await rebuildStored(d1, "shopify", "9001");
    expect(ledger(sqlite)[0]).toMatchObject({ commission_cents: 21351, journal_status: "posted" });
  });

  it("an item later found to be LOFI-owned drops out of the unposted ledger", async () => {
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    await ingestAndReport(d1, shopifyFixture());
    sqlite.prepare("UPDATE stock_items SET ownership = 'owned', consignor_id = NULL, acquired_from = 'registered_supplier' WHERE sku = 'RM-256549-001196-140526'").run();
    await rebuildStored(d1, "shopify", "9001");
    expect(ledger(sqlite)).toEqual([]);
  });
});

describe("consignment module stays in shadow mode", () => {
  it("is labelled shadow mode, and no code marks entries posted or paid", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { CONSIGNMENT_MODULE_MODE } = await import("../src/accounting/consignment");
    expect(CONSIGNMENT_MODULE_MODE).toBe("shadow");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e: import("node:fs").Dirent) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const src = files(join(import.meta.dirname, "../src")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src).not.toMatch(/journal_status\s*=\s*'posted'|journal_status\s*=\s*"posted"|'paid'/);
  });

  it("the Consignments page says SHADOW MODE and calls its figures provisional", async () => {
    const worker = (await import("../src/index")).default;
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    await ingestAndReport(d1, shopifyFixture());
    const html = await (await worker.fetch(new Request("http://local/consignments"), { DB: d1 } as never)).text();
    expect(html).toContain("SHADOW MODE");
    expect(html).toContain("Jess's manual consignment ledger is the source of truth");
    expect(html).toContain("provisional");
    expect(html).not.toMatch(/>Payable to consignors</);
  });
});
