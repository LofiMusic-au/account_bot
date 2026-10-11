// Milestone 2 locked rules at the channel level: local pickup, even discount
// split (incl. a mixed GST / GST-free order), and FX preservation.

import { describe, expect, it } from "vitest";
import { baselineSplit } from "../src/accounting/baseline";
import { buildJournalPreview } from "../src/posting/journal";
import { buildReport } from "../src/reconcile";
import { ebayFixture, fixtureResolver, shopifyFixture } from "./helpers";

const resolve = fixtureResolver();
const orderLevel = (amount: string) => ({
  allocatedAmountSet: { shopMoney: { amount } },
  discountApplication: { allocationMethod: "ACROSS", targetSelection: "ALL", targetType: "LINE_ITEM" },
});

describe("local pickup is a normal domestic sale", () => {
  it("Shopify: fulfillment order PICK_UP with no shipping address -> AU, Sales / GST (R8)", () => {
    const p = shopifyFixture((f) => {
      f.orders[1]!.shippingAddress = null;
      f.orders[1]!.deliveryMethods = ["PICK_UP"];
    });
    const sale = p.sales.find((s) => s.orderName === "#3260")!;
    expect(sale).toMatchObject({ destinationCountry: "AU", deliveryMethod: "pickup", shippingProgram: "domestic" });
    const l = baselineSplit(p, resolve).lines.find((x) => x.sku === "L-DISC-1")!;
    expect(l).toMatchObject({ category: "SALES_DOMESTIC_GST", ruleId: "R8" });
  });

  it("Shopify: without the delivery method the destination stays unknown (no guess from a missing address)", () => {
    const p = shopifyFixture((f) => void (f.orders[1]!.shippingAddress = null));
    expect(p.sales.find((s) => s.orderName === "#3260")!.destinationCountry).toBeNull();
  });

  it("eBay: PREPARE_FOR_PICKUP with no ship-to -> AU domestic", () => {
    const p = ebayFixture((f) => void (f.orders[0]!.fulfillmentStartInstructions = [{ fulfillmentInstructionsType: "PREPARE_FOR_PICKUP" }]));
    expect(p.sales[0]).toMatchObject({ destinationCountry: "AU", deliveryMethod: "pickup", shippingProgram: "domestic" });
  });
});

describe("order-level discounts are split evenly across items", () => {
  // #3252: Step-down $65.00 (LOFI-owned, Sales / GST) + Wavestation $854.05
  // (consigned, Commission Sales / GST free) + $45.95 shipping. A $30
  // order-level discount that Shopify allocated in proportion ($2.12 / $27.88).
  const discounted = () =>
    shopifyFixture((f) => {
      const o = f.orders[0]!;
      o.lineItems.nodes[0]!.discountAllocations = [orderLevel("2.12")];
      o.lineItems.nodes[1]!.discountAllocations = [orderLevel("27.88")];
      o.totalPriceSet.shopMoney.amount = "935.00";
      const t = f.transactions[0]!;
      t.amount.amount = "935.00";
      t.net.amount = "917.63";
      f.payout.net.amount = "1696.16";
    });

  it("$30 across 2 items -> $15 each, replacing Shopify's proportional allocation", () => {
    const p = discounted();
    const lines = p.sales.find((s) => s.orderName === "#3252")!.lines;
    expect(lines.map((l) => [l.discountCents, l.grossCents])).toEqual([
      [1500, 5000],
      [1500, 83905],
    ]);
    expect(p.warnings.join()).toMatch(/order-level discount 30\.00 split evenly across 2 item/);
  });

  it("each item keeps its own classification, and the mixed GST / GST-free journal still balances", () => {
    const r = buildReport(discounted(), resolve);
    expect(r.differenceCents).toBe(0);
    const split = r.baseline!.lines.filter((l) => l.orderId === "gid://shopify/Order/3252" && l.kind === "item");
    expect(split.map((l) => [l.category, l.cents])).toEqual([
      ["SALES_DOMESTIC_GST", 5000],
      ["CONSIGNMENT_SALES_NO_GST", 83905],
    ]);
    const j = buildJournalPreview(r);
    expect(j.totalDebitCents).toBe(j.totalCreditCents);
    expect(j.lines.find((l) => l.kind === "clearing")!.amountCents).toBe(169616);
  });

  it("a line-level discount stays on its own line", () => {
    const p = shopifyFixture((f) => {
      f.orders[1]!.lineItems.nodes[0]!.discountAllocations = [
        { allocatedAmountSet: { shopMoney: { amount: "40.00" } }, discountApplication: { allocationMethod: "EACH", targetSelection: "EXPLICIT", targetType: "LINE_ITEM" } },
      ];
    });
    expect(p.sales.find((s) => s.orderName === "#3260")!.lines[0]).toMatchObject({ discountCents: 4000, grossCents: 36000 });
  });
});

describe("FX: the marketplace's own conversion is kept", () => {
  it("Shopify: presentment amount, settlement rate and the AUD amount used for accounting", () => {
    const p = shopifyFixture((f) => {
      const o = f.orders[2]!; // #3261 to NZ
      o.presentmentCurrencyCode = "NZD";
      o.totalPriceSet.presentmentMoney = { amount: "616.00", currencyCode: "NZD" };
      o.transactions = [
        {
          kind: "SALE",
          status: "SUCCESS",
          gateway: "shopify_payments",
          amountSet: { shopMoney: { amount: "560.00", currencyCode: "AUD" }, presentmentMoney: { amount: "616.00", currencyCode: "NZD" } },
          settlementCurrency: "AUD",
          settlementCurrencyRate: "0.909090",
        },
      ];
    });
    const sale = p.sales.find((s) => s.orderName === "#3261")!;
    expect(sale.fx).toEqual({ currency: "NZD", foreignAmount: "616.00", rate: "0.909090", audCents: 56000, source: "shopify_presentment_settlement" });
    expect(sale.grossCents).toBe(56000); // accounting value = Shopify's AUD amount
    const r = buildReport(p, resolve);
    expect(r.fx).toEqual([{ orderId: sale.orderId, ...sale.fx! }]);
    expect(buildJournalPreview(r).fx).toHaveLength(1);
  });
});
