// Prints SQL that loads a demo consignor, stock records and one sample payout
// report into the local D1 database, so the dashboard can be tried before any
// API credentials are set up:
//   npx vite-node scripts/demo-sql.ts > .wrangler/demo.sql
//   npx wrangler d1 execute lofi-recon --local --file .wrangler/demo.sql
import { normaliseShopifyPayout, type ShopifyOrder } from "../src/channels/shopify";
import { makeResolver } from "../src/db";
import { buildReport } from "../src/reconcile";

const money = (amount: string) => ({ shopMoney: { amount } });
const li = (id: string, sku: string, name: string, amount: string) => ({
  id, sku, name, quantity: 1, originalTotalSet: money(amount), discountAllocations: [], taxLines: [],
});
const order = (n: string, ship: string, total: string, lines: ReturnType<typeof li>[], country = "AU"): ShopifyOrder => ({
  id: `gid://shopify/Order/${n}`, name: `#${n}`, createdAt: "2026-10-03T00:00:00Z", presentmentCurrencyCode: "AUD",
  paymentGatewayNames: ["shopify_payments"], taxesIncluded: true, shippingAddress: { countryCodeV2: country },
  totalShippingPriceSet: money(ship), totalPriceSet: money(total), lineItems: { nodes: lines },
});
const orders = new Map([
  order("3250", "38.95", "1178.0", [li("a", "L-mk3-0010230-300726", "Tascam Portastudio 424 MKIII", "1139.05")]),
  order("3251", "13.95", "74.35", [li("b", "tascamporta1&2/PS", "Power Supply Adapter for Tascam Porta One & Two", "31.95"), li("c", "G50-UD80m-31826", "Maxell UD2 80 min Type II cassette", "28.45")]),
  order("3252", "45.95", "965.0", [li("d", "240/100_Stepdown", "240V - 100V 50W Step-Down Transformer", "65.0"), li("e", "RM-256549-001196-140526", "Korg Wavestation A/D Synthesiser Rack", "854.05")]),
  order("3247", "38.95", "321.5", [li("f", "240/100_Stepdown", "240V - 100V 50W Step-Down Transformer", "65.0"), li("g", "P41-ZD05714-270826", "Roland M-12E 12-Channel Rackmount Mixer", "217.55")], "NZ"),
].map((o) => [o.id, o]));
const m = (a: string) => ({ amount: a, currencyCode: "AUD" });
const t = (id: string, type: string, amount: number, fee: number, o?: string) => ({
  id, type, sourceType: type, test: false, transactionDate: "2026-10-03T00:00:00Z", adjustmentReason: null,
  amount: m(amount.toFixed(2)), fee: m(fee.toFixed(2)), net: m((amount - fee).toFixed(2)),
  associatedOrder: o ? { id: `gid://shopify/Order/${o}`, name: `#${o}` } : null,
});
const txns = [t("1", "CHARGE", 1178, 20.38, "3250"), t("2", "CHARGE", 74.35, 1.56, "3251"), t("3", "CHARGE", 965, 16.71, "3252"), t("4", "CHARGE", 321.5, 8.36, "3247")];
const net = txns.reduce((a, x) => a + Number(x.net.amount), 0);
const payout = normaliseShopifyPayout(
  { id: "demo", legacyResourceId: "DEMO-1", issuedAt: "2026-10-06T00:00:00Z", status: "PAID", transactionType: "DEPOSIT", net: m(net.toFixed(2)) },
  txns, orders,
);
const consignors = [{ id: 1, name: "Demo consignor (private)", gst_registered: 0, commission_type: "percent" as const, commission_value: 25, agreement_type: "agency" as const }];
const row = (sku: string, ownership: "owned" | "consignment", acquired: string | null, purchase: number | null, consignor: number | null) => ({
  sku, title: null, ownership, acquired_from: acquired as never, purchase_cents: purchase, purchase_date: purchase ? "2026-07-30" : null,
  seller_name: null, seller_address: null, seller_description: null, consignor_id: consignor, commission_type: null, commission_value: null, override_scenario: null,
});
const items = [
  row("L-mk3-0010230-300726", "owned", "private_seller", 60000, null),
  row("RM-256549-001196-140526", "consignment", null, null, 1),
  row("P41-ZD05714-270826", "owned", "registered_supplier", null, null),
];
const prefixes = [
  { prefix: "240/100", ownership: "owned" as const, acquired_from: "registered_supplier" as const, consignor_id: null, commission_type: null, commission_value: null },
  { prefix: "tascamporta", ownership: "owned" as const, acquired_from: "registered_supplier" as const, consignor_id: null, commission_type: null, commission_value: null },
];
const report = buildReport(payout, makeResolver(items, prefixes, consignors));
const q = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const out: string[] = [];
out.push(`INSERT OR REPLACE INTO consignors (id, name, gst_registered, commission_type, commission_value, agreement_type) VALUES (1, 'Demo consignor (private)', 0, 'percent', 25, 'agency');`);
for (const i of items) out.push(`INSERT OR REPLACE INTO stock_items (sku, ownership, acquired_from, purchase_cents, purchase_date, consignor_id) VALUES (${[i.sku, i.ownership, i.acquired_from, i.purchase_cents, i.purchase_date, i.consignor_id].map(q).join(", ")});`);
for (const p of prefixes) out.push(`INSERT OR REPLACE INTO sku_prefix_rules (prefix, description, ownership, acquired_from) VALUES (${q(p.prefix)}, 'demo', 'owned', 'registered_supplier');`);
out.push(`INSERT OR REPLACE INTO payout_reports (channel, payout_id, payout_date, net_cents, expected_cents, difference_cents, status, sale_count, review_count, gst_cents, report_json, generated_at) VALUES (${[
  report.channel, report.payoutId, report.payoutDate, report.netCents, report.expectedCents, report.differenceCents, report.status,
  report.saleCount, report.reviewCount, report.totals.gstCents, JSON.stringify(report), report.generatedAt].map(q).join(", ")});`);
console.log(out.join("\n"));
