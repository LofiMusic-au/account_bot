// Regression tests from masked live LOFI eBay payouts (Oct 2026). Real IDs are
// replaced; amounts and field shapes are as eBay sent them.

import { describe, expect, it } from "vitest";
import { normaliseShopifyPayout, type ShopifyBalanceTxn, type ShopifyOrder, type ShopifyPayout } from "../src/channels/shopify";
import { baselineSplit } from "../src/accounting/baseline";
import { normaliseEbayPayout, type EbayOrder, type EbayPayout, type EbayTransaction } from "../src/channels/ebay";
import { convertAtRate } from "../src/money";
import { buildReport } from "../src/reconcile";
import { ingestAndReport } from "../src/index";
import { loadFixture, makeTestD1 } from "./helpers";

interface Live {
  payout: EbayPayout;
  transactions: EbayTransaction[];
  orders: EbayOrder[];
}
const live = (name: string) => {
  const f = loadFixture<Live>(`live/${name}.json`);
  return normaliseEbayPayout(f.payout, f.transactions, new Map(f.orders.map((o) => [o.orderId, o])));
};
const NAMES = ["ebay-refund-fee-credit", "ebay-non-sale-charge", "ebay-foreign-currency"];

describe("live eBay payout shapes", () => {
  for (const name of NAMES) {
    it(`${name}: reconciles to the cent, every record traced, re-import idempotent`, async () => {
      const p = live(name);
      const r = buildReport(p, () => null);
      expect(r.differenceCents).toBe(0);
      const sources = [...p.sales.flatMap((s) => s.sources), ...p.fees.map((f) => f.source), ...p.refunds.map((x) => x.source), ...p.adjustments.map((a) => a.source)];
      expect(sources.every((s) => s.transactionId?.startsWith("LIVE-"))).toBe(true);
      expect(p.adjustments.filter((a) => !a.supported)).toEqual([]);
      // Without order details nothing is classified, and nothing is guessed.
      expect(r.status).toBe("needs_review");
      expect(r.sales.every((l) => l.scenario === "REVIEW")).toBe(true);
      const { d1, sqlite } = makeTestD1();
      await ingestAndReport(d1, p);
      await ingestAndReport(d1, p);
      expect(sqlite.prepare("SELECT count(*) AS n FROM source_transactions").get()).toEqual({ n: p.raw.transactions.length });
    });
  }

  it("gross sale = net + fees, matching eBay's own fee basis on every AUD sale", () => {
    for (const name of NAMES) {
      const f = loadFixture<Live>(`live/${name}.json`);
      for (const t of f.transactions.filter((x) => x.transactionType === "SALE" && !x.amount.convertedFromCurrency)) {
        const net = Math.round(Number(t.amount.value) * 100);
        const fees = Math.round(Number(t.totalFeeAmount!.value) * 100);
        expect(net + fees).toBe(Math.round(Number(t.totalFeeBasisAmount!.value) * 100));
      }
      expect(live(name).warnings.filter((w) => /fee basis/.test(w))).toEqual([]);
    }
  });

  it("a refund is net of the fee credit: refund gross = amount + fees, fees come back as credits", () => {
    const p = live("ebay-refund-fee-credit");
    expect(p.refunds).toHaveLength(1);
    expect(p.refunds[0]!.cents).toBe(2590); // 23.46 DEBIT + 2.44 fee credit = 25.90 fee basis
    const credits = p.fees.filter((f) => f.cents < 0);
    expect(credits.map((f) => [f.type, f.cents])).toEqual([
      ["ebay_final_value_fee", -122],
      ["ebay_final_value_fee", -122],
    ]);
    const r = buildReport(p, () => null);
    expect(r.breakdown.refundsCents).toBe(2590);
    expect(r.netCents).toBe(11495);
  });

  it("a non-sale charge (OTHER_FEES) is an 'other' fee", () => {
    const p = live("ebay-non-sale-charge");
    expect(p.fees.find((f) => f.cents === 7495)).toMatchObject({ type: "ebay_other_fee", category: "other" });
  });

  it("foreign-currency sales convert fees at eBay's rate instead of reading EUR/USD as AUD", () => {
    const p = live("ebay-foreign-currency");
    const eur = p.sales.find((s) => s.buyerCurrency === "EUR")!;
    const usd = p.sales.find((s) => s.buyerCurrency === "USD")!;
    // EUR 0.48, 0.45, 5.23 at 1.56408 -> 0.75 + 0.70 + 8.18 = 9.63; net AUD 52.91
    expect(eur.grossCents).toBe(5291 + 963);
    // USD 7.08, 0.40, 0.76 at 1.34292 -> 9.51 + 0.54 + 1.02 = 11.07; net AUD 82.21
    expect(usd.grossCents).toBe(8221 + 1107);
    expect(convertAtRate(3999, "1.56408")).toBe(6255); // converted fee basis: within a cent of the gross
    const eurFees = p.fees.filter((f) => f.source.rawCurrency === "EUR");
    expect(eurFees.map((f) => f.cents)).toEqual([75, 70, 818]);
    expect(eurFees[0]!.source.rawAmount).toBe("0.48");
    const r = buildReport(p, () => null);
    expect(r.differenceCents).toBe(0);
    expect(r.breakdown.feesByCategory.marketplace).toBe(41023);
    // FX rule: eBay's own conversion is kept with the sale.
    expect(eur.fx).toEqual({ currency: "EUR", foreignAmount: "33.83", rate: "1.56408", audCents: 5291, source: "ebay_convertedFrom" });
    expect(r.issues.some((i) => i.code === "fx_policy_pending")).toBe(false);
  });

  it("tax eBay collected and remitted (live spelling ebayCollectedTaxAmount) is noted and kept out of the gross", () => {
    const p = live("ebay-foreign-currency");
    expect(p.warnings.filter((w) => /collected and remitted EUR 7.6 tax/.test(w))).toHaveLength(1);
    expect(p.sales.find((s) => s.buyerCurrency === "EUR")!.grossCents).toBe(6254);
  });

  it("fees in a currency with no exchange rate block the payout", () => {
    const f = loadFixture<Live>("live/ebay-foreign-currency.json");
    const t = f.transactions.find((x) => x.amount.convertedFromCurrency === "EUR")!;
    delete t.amount.exchangeRate;
    const p = normaliseEbayPayout(f.payout, f.transactions, new Map());
    expect(p.issues.some((i) => i.code === "non_aud_transaction" && /no exchange rate/.test(i.message))).toBe(true);
  });
});

describe("live eBay order details (Fulfillment API)", () => {
  it("every AUD sale matches its order; foreign orders match in their own currency and split the AUD gross", () => {
    for (const name of NAMES) {
      const p = live(name);
      expect(p.issues.filter((i) => i.code === "sale_amount_mismatch" || i.code === "order_details_missing")).toEqual([]);
      for (const s of p.sales) {
        expect(s.lines.reduce((a, l) => a + l.grossCents, 0) + s.shippingCents).toBe(s.grossCents);
      }
    }
    const fx = live("ebay-foreign-currency");
    expect(fx.warnings.filter((w) => /order priced in (EUR|USD)/.test(w))).toHaveLength(2);
    const eur = fx.sales.find((s) => s.buyerCurrency === "EUR")!;
    expect(eur.destinationCountry).toBe("DE");
    expect(eur.shippingProgram).toBe("direct_export");
    expect(eur.grossCents).toBe(6254);
  });

  it("a partial refund is matched to its original order and reverses its lines", () => {
    const p = live("ebay-refund-fee-credit");
    expect(p.refunds[0]!.order).not.toBeNull();
    const r = buildReport(p, () => null);
    expect(r.issues.some((i) => i.code === "refund_unmatched")).toBe(false);
    expect(r.refunds.reduce((a, l) => a + l.grossCents, 0)).toBe(-2590);
  });

  it("a listing without a SKU on eBay is keyed on its listing ID, and still needs facts", () => {
    const p = live("ebay-foreign-currency");
    const line = p.sales.flatMap((s) => s.lines).find((l) => l.skuFromListing)!;
    expect(line.sku).toMatch(/^EBAY-ITEM-LIVE-LISTING-\d+$/);
    const r = buildReport(p, () => null);
    expect(r.issues.filter((i) => i.code === "unknown_sku")).toHaveLength(0);
    const issue = r.issues.find((i) => i.sku === line.sku)!;
    expect(issue.code).toBe("unknown_stock_record");
    expect(issue.message).toMatch(/No SKU on the eBay listing/);
  });
});

describe("live Shopify Payments payouts with order details", () => {
  type ShopifyLive = { payouts: { payout: ShopifyPayout; transactions: ShopifyBalanceTxn[]; orders: ShopifyOrder[] }[] };
  const f = loadFixture<ShopifyLive>("live/shopify-charges-refund.json");
  const norm = (i: number, withOrders = true) => {
    const x = f.payouts[i]!;
    return normaliseShopifyPayout(x.payout, x.transactions, new Map(withOrders ? x.orders.map((o) => [o.id, o]) : []));
  };

  it("reconcile to the cent; every charge equals its order total; net = amount - fee", () => {
    for (const i of [0, 1]) {
      const p = norm(i);
      const r = buildReport(p, () => null);
      expect(r.differenceCents).toBe(0);
      expect(p.warnings.filter((w) => /part-paid|Shopify total/.test(w))).toEqual([]);
      expect(p.issues.filter((i) => i.severity === "blocking")).toEqual([]);
    }
    expect(buildReport(norm(0), () => null).breakdown).toMatchObject({ salesGrossCents: 35100, refundsCents: 500, feesCents: 777 });
  });

  it("the refund is matched to its earlier order and reverses that order's lines", () => {
    const p = norm(0);
    expect(p.refunds[0]!.order).not.toBeNull();
    const r = buildReport(p, () => null);
    expect(r.issues.some((i) => i.code === "refund_unmatched")).toBe(false);
    expect(r.refunds.reduce((a, l) => a + l.grossCents, 0)).toBe(-500);
  });

  it("multi-line orders split into lines + shipping that add up; an export to France is overseas", () => {
    const p = norm(1);
    const multi = p.sales.filter((s) => s.lines.length > 1);
    expect(multi.length).toBe(2);
    for (const s of p.sales) expect(s.lines.reduce((a, l) => a + l.grossCents, 0) + s.shippingCents).toBe(s.grossCents);
    const fr = norm(0).sales.find((s) => s.destinationCountry === "FR")!;
    expect(fr.shippingProgram).toBe("direct_export");
    expect(baselineSplit(norm(0), () => ({ sku: "x", ownership: "owned", source: "item" })).lines.find((l) => l.orderId === fr.orderId && l.kind === "item")!.category).toBe("SALES_OVERSEAS_NO_GST");
  });

  it("without order access the payout still reconciles and every sale says why it's held", () => {
    const x = f.payouts[0]!;
    const errors = new Map(x.transactions.flatMap((t) => (t.associatedOrder ? [[t.associatedOrder.id, "Access denied for Order object"]] : [])) as [string, string][]);
    const p = normaliseShopifyPayout(x.payout, x.transactions, new Map(), errors);
    expect(buildReport(p, () => null).differenceCents).toBe(0);
    expect(p.issues.filter((i) => i.code === "order_details_missing").every((i) => /Access denied/.test(i.message))).toBe(true);
  });
});
