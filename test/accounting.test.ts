// Historical accounting baseline: stage 1 (payout split by logical category)
// and stage 2 (consignment subledger). These assert LOFI's current manual
// method, captured as the operational baseline, not accountant-approved law.

import { describe, expect, it } from "vitest";
import { baselineSplit } from "../src/accounting/baseline";
import { consignmentEntries, costKey, periodTotals, settle, validateRule, type SettlementRule } from "../src/accounting/consignment";
import { clearPayouts, createRule, makeResolver, saveCosts } from "../src/db";
import { gstInclusive } from "../src/money";
import { buildReport } from "../src/reconcile";
import { ingestAndReport, rebuildStored } from "../src/index";
import { FIXTURE_CONSIGNORS, ebayFixture, fixtureResolver, makeTestD1, seedFixtureFacts, shopifyFixture } from "./helpers";

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

// ----------------------------------------------------------------- stage 2

const rule = (name: string, shares: [string, "consignor" | "lofi" | "partner", number | null, number | null][], over: Partial<SettlementRule> = {}): SettlementRule => ({
  id: 1,
  name,
  deductPostage: true,
  deductFees: true,
  deductRepairs: true,
  deductOther: true,
  includeShippingCharged: true,
  basTreatment: "unconfirmed",
  parties: shares.map(([n, role, pct, fixed]) => ({ name: n, role, shareBp: pct === null ? null : pct * 100, fixedCents: fixed })),
  ...over,
});
const R65_25_10 = rule("65/25/10", [["Consignor", "consignor", 65, null], ["LOFI", "lofi", 25, null], ["Repairer", "partner", 10, null]]);

describe("stage 2: settlement calculation (Jess's ledger)", () => {
  it("NET = sale - postage - fees - repairs - other, then shared 65/25/10", () => {
    const r = settle({ grossSaleCents: 100000, postageCents: 2000, feesCents: 10000, repairsCents: 5000, otherCents: 0 }, R65_25_10);
    expect(r.distributableNetCents).toBe(83000);
    expect(r.shares.map((x) => x.cents)).toEqual([53950, 20750, 8300]);
    expect(r).toMatchObject({ consignorShareCents: 53950, lofiShareCents: 20750, otherSharesCents: 8300 });
  });

  it("supports the ledger's other splits, and shares always add up to NET exactly", () => {
    const splits: [string, number[]][] = [
      ["65/25/5/5", [65, 25, 5, 5]],
      ["75/20/5", [75, 20, 5]],
      ["50/50", [50, 50]],
    ];
    for (const [name, pcts] of splits) {
      const r = rule(name, pcts.map((p, i) => [`P${i}`, i === 0 ? "consignor" : i === 1 ? "lofi" : "partner", p, null]));
      for (const gross of [12345, 99999, 1]) {
        const out = settle({ grossSaleCents: gross, postageCents: 0, feesCents: 0, repairsCents: 0, otherCents: 0 }, r);
        expect(out.shares.reduce((a, x) => a + x.cents, 0)).toBe(out.distributableNetCents);
      }
    }
    const fifty = settle({ grossSaleCents: 100001, postageCents: 0, feesCents: 0, repairsCents: 0, otherCents: 0 }, rule("50/50", [["C", "consignor", 50, null], ["LOFI", "lofi", 50, null]]));
    expect(fifty.shares.map((x) => x.cents).sort()).toEqual([50000, 50001]);
  });

  it("fixed amounts come off first; the percentage parties share the rest", () => {
    const r = rule("fixed + 50/50", [["C", "consignor", 50, null], ["LOFI", "lofi", 50, null], ["Tech", "partner", null, 5000]]);
    const out = settle({ grossSaleCents: 30000, postageCents: 0, feesCents: 0, repairsCents: 0, otherCents: 0 }, r);
    expect(out.shares.map((x) => x.cents)).toEqual([12500, 12500, 5000]);
  });

  it("each rule chooses which costs it deducts", () => {
    const noFees = { ...R65_25_10, deductFees: false };
    expect(settle({ grossSaleCents: 100000, postageCents: 2000, feesCents: 10000, repairsCents: 5000, otherCents: 0 }, noFees).distributableNetCents).toBe(93000);
  });

  it("BAS on LOFI's share is not assumed: unconfirmed gives no figure", () => {
    const input = { grossSaleCents: 110000, postageCents: 0, feesCents: 0, repairsCents: 0, otherCents: 0 };
    expect(settle(input, R65_25_10).lofiShareGstCents).toBeNull();
    expect(settle(input, { ...R65_25_10, basTreatment: "gst_on_lofi_share" }).lofiShareGstCents).toBe(gstInclusive(27500));
    expect(settle(input, { ...R65_25_10, basTreatment: "none" }).lofiShareGstCents).toBe(0);
  });

  it("a refund reverses the split", () => {
    const out = settle({ grossSaleCents: -100000, postageCents: 0, feesCents: -10000, repairsCents: 0, otherCents: 0 }, R65_25_10);
    expect(out.distributableNetCents).toBe(-90000);
    expect(out.shares.map((x) => x.cents)).toEqual([-58500, -22500, -9000]);
  });

  it("validates rules", () => {
    expect(validateRule(R65_25_10)).toEqual([]);
    expect(validateRule(rule("bad", [["C", "consignor", 60, null], ["LOFI", "lofi", 25, null]]))).toContain("percentage shares must add up to 100%");
    expect(validateRule(rule("bad", [["C", "consignor", 50, null], ["D", "consignor", 50, null]])).join()).toMatch(/exactly one consignor.*exactly one LOFI/);
    expect(validateRule(rule("bad", [["C", "consignor", 100, 500], ["LOFI", "lofi", null, 100]])).join()).toMatch(/either a percentage or a fixed amount/);
  });
});

describe("stage 2: ledger entries from a payout", () => {
  const withRule = (r: SettlementRule) => ({ rules: new Map([[1, r]]), costs: new Map() });
  const resolver = (ruleId: number | null) =>
    makeResolver(
      [
        { sku: "RM-256549-001196-140526", title: null, ownership: "consignment", acquired_from: null, purchase_cents: null, purchase_date: null, seller_name: null, seller_address: null, seller_description: null, consignor_id: 1, commission_type: null, commission_value: null, override_scenario: null },
        { sku: "RM-CONS-1", title: null, ownership: "consignment", acquired_from: null, purchase_cents: null, purchase_date: null, seller_name: null, seller_address: null, seller_description: null, consignor_id: 1, commission_type: null, commission_value: null, override_scenario: null },
      ],
      [],
      [{ ...FIXTURE_CONSIGNORS[0]!, settlement_rule_id: ruleId }],
    );

  it("the sale and its share of the fees come in automatically; shipping the buyer paid is part of the sale", () => {
    const [e] = consignmentEntries(shopifyFixture(), resolver(1), withRule(R65_25_10));
    // #3252: Wavestation $854.05 + $42.70 of the $45.95 shipping; $16.14 of the $17.37 payment fee
    expect(e).toMatchObject({ kind: "sale", itemCents: 85405, shippingChargedCents: 4270, grossSaleCents: 89675, feesCents: 1614, postageCents: 0, postageSource: "none" });
    expect(e!.distributableNetCents).toBe(88061);
    expect(e!.consignorShareCents! + e!.lofiShareCents! + e!.otherSharesCents!).toBe(88061);
    expect(e!.lofiShareGstCents).toBeNull();
    expect(e!.status).toBe("calculated");
  });

  it("postage defaults to the platform shipping label, and a manual entry overrides it; repairs come off too", () => {
    const payout = ebayFixture((f) => void (f.transactions.find((t) => t.transactionType === "SHIPPING_LABEL")!.orderId = "26-00003-00003"));
    const [auto] = consignmentEntries(payout, resolver(1), withRule(R65_25_10));
    expect(auto).toMatchObject({ grossSaleCents: 110000, feesCents: 12030, postageCents: 1240, postageSource: "shipping_label", distributableNetCents: 110000 - 12030 - 1240 });
    const costs = new Map([[costKey("ebay", "26-00003-00003", "3001"), { postageCents: 2500, repairsCents: 8000, otherCents: null }]]);
    const [manual] = consignmentEntries(payout, resolver(1), { rules: new Map([[1, R65_25_10]]), costs });
    expect(manual).toMatchObject({ postageCents: 2500, postageSource: "manual", repairsCents: 8000, distributableNetCents: 110000 - 12030 - 2500 - 8000 });
  });

  it("no settlement rule: the entry is kept as incomplete and left out of the totals", () => {
    const e = consignmentEntries(shopifyFixture(), resolver(null), withRule(R65_25_10));
    expect(e[0]).toMatchObject({ status: "incomplete", problem: "No settlement rule for this consignor or item", distributableNetCents: null });
    expect(periodTotals(e)[0]).toMatchObject({ entries: 1, incomplete: 1, netCents: 0 });
  });

  it("the payout split keeps the consignment sale at no GST; nothing from the ledger flows into it", () => {
    const split = baselineSplit(shopifyFixture(), resolver(1));
    const line = split.lines.find((l) => l.sku === "RM-256549-001196-140526")!;
    expect(line.category).toBe("CONSIGNMENT_SALES_NO_GST");
    expect(line.cents).toBe(85405);
    expect(Object.keys(line)).not.toContain("gstCents");
  });
});

describe("stage 2: the shadow ledger in the database", () => {
  const ledger = (sqlite: ReturnType<typeof makeTestD1>["sqlite"]) =>
    sqlite.prepare("SELECT entry_key, kind, gross_sale_cents, fees_cents, postage_cents, repairs_cents, distributable_net_cents, consignor_share_cents, lofi_share_cents, other_shares_cents FROM consignment_entries ORDER BY entry_key").all() as Record<string, unknown>[];
  async function setup() {
    const t = makeTestD1();
    seedFixtureFacts(t.sqlite);
    const id = await createRule(t.d1, { ...R65_25_10 }, 1);
    return { ...t, ruleId: id };
  }

  it("is fed automatically by ingest, and re-import doesn't duplicate entries", async () => {
    const { d1, sqlite } = await setup();
    await ingestAndReport(d1, shopifyFixture());
    await ingestAndReport(d1, ebayFixture());
    const first = ledger(sqlite);
    expect(first).toHaveLength(2);
    expect(first.every((x) => x.distributable_net_cents !== null)).toBe(true);
    await ingestAndReport(d1, shopifyFixture());
    await ingestAndReport(d1, ebayFixture());
    await rebuildStored(d1, "shopify", "9001");
    expect(ledger(sqlite)).toEqual(first);
  });

  it("changing the settlement rule recalculates the split but never alters the source sale", async () => {
    const { d1, sqlite } = await setup();
    await ingestAndReport(d1, shopifyFixture());
    const sourceBefore = sqlite.prepare("SELECT transaction_id, raw_amount, payload_hash FROM source_transactions ORDER BY transaction_id").all();
    const stored = sqlite.prepare("SELECT normalised_json FROM source_payouts").get();
    const fifty = await createRule(d1, rule("50/50", [["Consignor", "consignor", 50, null], ["LOFI", "lofi", 50, null]]), 1);
    expect(fifty).toBeGreaterThan(0);
    await rebuildStored(d1, "shopify", "9001");
    expect(sqlite.prepare("SELECT transaction_id, raw_amount, payload_hash FROM source_transactions ORDER BY transaction_id").all()).toEqual(sourceBefore);
    expect(sqlite.prepare("SELECT normalised_json FROM source_payouts").get()).toEqual(stored);
    const row = ledger(sqlite)[0]!;
    expect(row.gross_sale_cents).toBe(89675);
    expect((row.consignor_share_cents as number) + (row.lofi_share_cents as number)).toBe(row.distributable_net_cents);
    expect(Math.abs((row.consignor_share_cents as number) - (row.lofi_share_cents as number))).toBeLessThanOrEqual(1); // odd NET: 1 cent apart
    expect(row.other_shares_cents).toBe(0);
  });

  it("manual costs persist across clearing and re-fetching payouts", async () => {
    const { d1, sqlite } = await setup();
    await ingestAndReport(d1, shopifyFixture());
    const line = sqlite.prepare("SELECT order_id, line_item_id FROM consignment_entries").get() as { order_id: string; line_item_id: string };
    await saveCosts(d1, "shopify", line.order_id, line.line_item_id, { postageCents: 3000, repairsCents: 12000, otherCents: null });
    await rebuildStored(d1, "shopify", "9001");
    expect(ledger(sqlite)[0]).toMatchObject({ postage_cents: 3000, repairs_cents: 12000 });
    await clearPayouts(d1);
    expect(ledger(sqlite)).toEqual([]);
    await ingestAndReport(d1, shopifyFixture());
    expect(ledger(sqlite)[0]).toMatchObject({ postage_cents: 3000, repairs_cents: 12000, distributable_net_cents: 89675 - 1614 - 3000 - 12000 });
  });

  it("an item later found to be LOFI-owned drops out of the ledger", async () => {
    const { d1, sqlite } = await setup();
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

describe("Consignments page forms (through the Worker)", () => {
  it("create a 65/25/10 rule as a consignor's default, enter repairs, and the ledger recalculates", async () => {
    const worker = (await import("../src/index")).default;
    const { d1, sqlite } = makeTestD1();
    seedFixtureFacts(sqlite);
    await ingestAndReport(d1, shopifyFixture());
    const env = { DB: d1 } as never;
    const post = (path: string, f: Record<string, string>) => worker.fetch(new Request(`http://local${path}`, { method: "POST", body: new URLSearchParams(f) }), env);

    const res = await post("/consignments/rules", {
      name: "65/25/10",
      consignor_id: "1",
      party_role_0: "consignor", party_name_0: "Consignor", party_pct_0: "65",
      party_role_1: "lofi", party_name_1: "LOFI", party_pct_1: "25",
      party_role_2: "partner", party_name_2: "Repairer", party_pct_2: "10",
      deduct_postage: "1", deduct_fees: "1", deduct_repairs: "1", deduct_other: "1", include_shipping: "1",
      bas_treatment: "unconfirmed", return: "/consignments",
    });
    expect(new URL(res.headers.get("Location")!, "http://x").searchParams.get("msg")).toBe("Added rule 65/25/10");
    let row = sqlite.prepare("SELECT * FROM consignment_entries").get() as Record<string, unknown>;
    expect(row).toMatchObject({ status: "calculated", distributable_net_cents: 88061 });
    expect(JSON.parse(row.shares_json as string).map((x: { cents: number }) => x.cents).reduce((a: number, b: number) => a + b, 0)).toBe(88061);

    await post("/consignments/costs", { channel: "shopify", order_id: row.order_id as string, line_item_id: row.line_item_id as string, repairs: "120.00", return: "/consignments" });
    row = sqlite.prepare("SELECT * FROM consignment_entries").get() as Record<string, unknown>;
    expect(row).toMatchObject({ repairs_cents: 12000, distributable_net_cents: 88061 - 12000 });

    const bad = await post("/consignments/rules", { name: "bad", party_role_0: "consignor", party_name_0: "C", party_pct_0: "60", party_role_1: "lofi", party_name_1: "LOFI", party_pct_1: "30", return: "/consignments" });
    expect(new URL(bad.headers.get("Location")!, "http://x").searchParams.get("msg")).toMatch(/^Not saved: .*100%/);

    const html = await (await worker.fetch(new Request("http://local/consignments"), env)).text();
    expect(html).toContain("SHADOW MODE");
    expect(html).toContain("Draft settlement — 2026-10");
    expect(html).toContain("Repairer");
  });
});
