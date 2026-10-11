// Live-read validation for Milestone 1. Reads one real payout, rebuilds it,
// and writes a validation report. Read-only: it calls only eBay / Shopify GET
// or GraphQL query endpoints, and writes only to .live/ (git-ignored) and,
// with --fixture, to a masked regression fixture under test/fixtures/live/.
//
//   npx vite-node scripts/live-validate.ts ebay --scan            # list recent payouts and their transaction types
//   npx vite-node scripts/live-validate.ts ebay <payoutId>        # validate one payout
//   npx vite-node scripts/live-validate.ts ebay <payoutId> --fixture <name>
//   npx vite-node scripts/live-validate.ts shopify [...]          # same for Shopify Payments
//
// Credentials come from the shell or from .dev.vars (git-ignored), never from tracked files:
//   eBay:    EBAY_ACCESS_TOKEN, or EBAY_CLIENT_ID + EBAY_CLIENT_SECRET + EBAY_REFRESH_TOKEN
//   Shopify: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app), or SHOPIFY_ADMIN_TOKEN

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EbayClient, ebayOrderForAudit, normaliseEbayPayout, type EbayOrder, type EbayPayout, type EbayTransaction } from "../src/channels/ebay";
import { normaliseShopifyPayout, ShopifyClient, type ShopifyBalanceTxn, type ShopifyOrder, type ShopifyPayout } from "../src/channels/shopify";
import { fmt, toCents } from "../src/money";
import { buildReport, type PayoutReport } from "../src/reconcile";
import { ingestAndReport } from "../src/index";
import type { NormalisedPayout } from "../src/types";
import { makeTestD1 } from "../test/helpers";

const [channel, rawArg, ...rest] = process.argv.slice(2);
// Accept --scan, -scan or scan.
const arg = rawArg && /^-{0,2}scan$/.test(rawArg) ? "--scan" : rawArg;
const fixtureName = rest[0] === "--fixture" ? rest[1] : undefined;
const root = join(import.meta.dirname, "..");
// Values come from the shell first, then .dev.vars (git-ignored, the same file
// `wrangler dev` reads), then wrangler.toml's plain vars for the shop/version.
const env: Record<string, string | undefined> = { ...readVars(join(root, ".dev.vars")), ...process.env };
env.SHOPIFY_SHOP ??= /SHOPIFY_SHOP\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "wrangler.toml"), "utf8"))?.[1];
env.SHOPIFY_API_VERSION ??= /SHOPIFY_API_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "wrangler.toml"), "utf8"))?.[1];
for (const k of Object.keys(env)) if (env[k] === "") delete env[k];

function readVars(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

const md = (rows: (string | number)[][]) =>
  rows.map((r, i) => `| ${r.join(" | ")} |${i === 0 ? `\n|${r.map(() => "---").join("|")}|` : ""}`).join("\n");
const c = (cents: number) => fmt(cents);

// ------------------------------------------------------------------ masking

/** Replaces real platform IDs with stable placeholders, for fixtures in a public repo. */
function masker() {
  const seen = new Map<string, string>();
  const counters = new Map<string, number>();
  return (kind: string, id: string | null | undefined) => {
    if (id === null || id === undefined) return id;
    const key = `${kind}:${id}`;
    if (!seen.has(key)) {
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      seen.set(key, `LIVE-${kind}-${n}`);
    }
    return seen.get(key)!;
  };
}

// --------------------------------------------------------------- shared run

async function verify(payout: NormalisedPayout) {
  const report = buildReport(payout, () => null); // no stock facts: classification is not under test here
  const { d1, sqlite } = makeTestD1();
  await ingestAndReport(d1, payout);
  await ingestAndReport(d1, payout);
  const counts = Object.fromEntries(
    ["source_payouts", "source_transactions", "source_orders", "payout_reports"].map((t) => [
      t,
      (sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );
  const traced = [
    ...payout.sales.flatMap((s) => s.sources),
    ...payout.fees.map((f) => f.source),
    ...payout.refunds.map((r) => r.source),
    ...payout.adjustments.map((a) => a.source),
  ];
  const untraced = traced.filter((s) => !s.transactionId).length;
  return { report, counts, untraced, tracedCount: traced.length };
}

function summary(report: PayoutReport, extra: { counts: Record<string, number>; untraced: number; tracedCount: number; rawCount: number }) {
  const b = report.breakdown;
  return [
    `**Actual payout:** ${c(report.netCents)} (${report.rawAmount} ${report.rawCurrency} as sent)`,
    `**Reconstructed:** ${c(report.expectedCents)}`,
    `**Difference:** ${c(report.differenceCents)}`,
    `**Status:** ${report.status}${report.provisional ? " (provisional)" : ""}`,
    "",
    md([
      ["Component", "Amount"],
      ["Items after discounts", c(b.itemsCents)],
      ["Shipping", c(b.shippingCents)],
      ["Discounts already deducted (info)", c(b.discountsCents)],
      ["Sales collected", c(b.salesGrossCents)],
      ["Refunds", c(-b.refundsCents)],
      ...Object.entries(b.feesByCategory).map(([k, v]) => [`Fees: ${k}`, c(-v)]),
      ["Adjustments (supported)", c(b.adjustmentsCents)],
      ["Unsupported types", c(b.unsupportedCents)],
      ["**Reconstructed**", `**${c(report.expectedCents)}**`],
    ]),
    "",
    `**Source tracing:** ${extra.tracedCount} normalised records, ${extra.untraced} without a source transaction ID. ${extra.rawCount} raw transactions kept.`,
    `**Re-import x2:** ${Object.entries(extra.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    "",
    "**Issues:**",
    ...(report.issues.length ? report.issues.map((i) => `- ${i.severity}: ${i.code} — ${i.message}`) : ["- none"]),
    "",
    "**Notes:**",
    ...(report.warnings.length ? report.warnings.map((w) => `- ${w}`) : ["- none"]),
  ].join("\n");
}

function save(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  console.log(`\nSaved to ${dir}`);
}

// ---------------------------------------------------------------------- eBay

async function ebay() {
  const client = new EbayClient({
    clientId: env.EBAY_CLIENT_ID ?? "",
    clientSecret: env.EBAY_CLIENT_SECRET ?? "",
    refreshToken: env.EBAY_REFRESH_TOKEN ?? "",
    accessToken: env.EBAY_ACCESS_TOKEN,
    marketplaceId: env.EBAY_MARKETPLACE_ID ?? "EBAY_AU",
  });
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const payouts = (await client.listPayouts(since)).sort((a, b) => b.payoutDate.localeCompare(a.payoutDate));
  if (!arg || arg === "--scan") {
    for (const p of payouts) {
      const txns = await client.payoutTransactions(p.payoutId);
      const types = new Map<string, number>();
      for (const t of txns) {
        const k = t.transactionType + (t.feeType ? `:${t.feeType}` : "");
        types.set(k, (types.get(k) ?? 0) + 1);
      }
      console.log(`${p.payoutId}  ${p.payoutDate.slice(0, 10)}  ${p.amount.value} ${p.amount.currency}  ${[...types].map(([k, n]) => `${k}×${n}`).join(", ")}`);
    }
    return;
  }
  const p = payouts.find((x) => x.payoutId === arg);
  if (!p) throw new Error(`Payout ${arg} not found in the last 30 days`);
  const raw = await client.fetchRaw(p);
  const payout = normaliseEbayPayout(raw.payout, raw.transactions, raw.orders, raw.orderErrors);
  const v = await verify(payout);

  const rows: (string | number)[][] = [
    ["eBay txn ID", "Type", "Order ID", "Order gross (Fulfillment)", "eBay fee basis", "Txn amount (signed)", "Fees", "Gross used", "Refund / adjustment", "Contribution to payout", "Raw currency", "Mapping notes"],
  ];
  let contributionSum = 0;
  for (const t of raw.transactions) {
    const signed = (t.bookingEntry === "CREDIT" ? 1 : -1) * toCents(t.amount.value);
    contributionSum += signed;
    const fees = toCents(t.totalFeeAmount?.value);
    const order = t.orderId ? raw.orders.get(t.orderId) : undefined;
    const orderGross = order
      ? order.lineItems.reduce((a, li) => a + toCents((li.discountedLineItemCost ?? li.lineItemCost).value) + toCents(li.deliveryCost?.shippingCost?.value), 0)
      : null;
    const basis = t.totalFeeBasisAmount ? toCents(t.totalFeeBasisAmount.value) : null;
    const notes: string[] = [];
    if (t.transactionType === "SALE") {
      // Compare in the transaction's own currency: on FX sales the fees and basis aren't AUD.
      const grossTxn = (t.amount.convertedFromCurrency ? toCents(t.amount.convertedFromValue) : signed) + fees;
      const gross = signed + fees;
      if (basis !== null) {
        notes.push(basis === grossTxn ? "net + fees = fee basis ✓" : `net + fees ${grossTxn} ≠ fee basis ${basis} (${t.totalFeeBasisAmount!.currency} cents)`);
      }
      if (orderGross !== null) notes.push(orderGross === gross ? "= order ✓" : `≠ order ${c(orderGross)}`);
      if (t.amount.convertedFromCurrency) notes.push(`fees and basis in ${t.amount.convertedFromCurrency}; AUD at rate ${t.amount.exchangeRate}`);
    }
    if (t.transactionType === "REFUND" && basis !== null && !t.amount.convertedFromCurrency) {
      notes.push(-signed + fees === basis ? "|amount| + fee credit = fee basis ✓" : `|amount| + fee credit ≠ fee basis ${c(basis)}`);
    }
    if (t.orderId && raw.orderErrors.has(t.orderId)) notes.push(`order not fetched (${raw.orderErrors.get(t.orderId)!.includes("OAuth") ? "token not accepted by Fulfillment API" : "error"})`);
    rows.push([
      t.transactionId,
      t.transactionType + (t.feeType ? ` (${t.feeType})` : ""),
      t.orderId ?? "",
      orderGross === null ? "—" : c(orderGross),
      basis === null ? "—" : c(basis),
      c(signed),
      fees ? c(fees) : "",
      t.transactionType === "SALE" || t.transactionType === "REFUND" ? c(signed + (t.transactionType === "SALE" ? fees : -fees)) : "",
      ["REFUND", "CREDIT", "ADJUSTMENT", "DISPUTE"].includes(t.transactionType) ? c(signed) : "",
      c(signed),
      t.amount.currency,
      notes.join("; "),
    ]);
  }
  const report = [
    `# eBay payout ${p.payoutId} — live validation`,
    "",
    `Payout date ${p.payoutDate}, status ${p.payoutStatus}, eBay transactionCount ${p.transactionCount ?? "?"}, fetched ${raw.transactions.length}.`,
    `Sum of signed transaction amounts: ${c(contributionSum)}.`,
    "",
    md(rows),
    "",
    summary(v.report, { ...v, rawCount: payout.raw.transactions.length }),
  ].join("\n");
  console.log(report);

  const sanitised = {
    payout: { ...p, payoutInstrument: undefined, bankReference: undefined },
    transactions: raw.transactions.map((t) => {
      const { buyer: _b, ...r } = t as EbayTransaction & { buyer?: unknown };
      return r;
    }),
    orders: [...raw.orders.values()].map((o) => ebayOrderForAudit(o)),
    orderErrors: Object.fromEntries(raw.orderErrors),
  };
  save(join(root, ".live", `ebay-${p.payoutId}`), { "validation.md": report, "sanitised.json": JSON.stringify(sanitised, null, 1) });

  if (fixtureName) {
    const m = masker();
    const fixture = {
      _note: `Masked from live eBay payout (${p.payoutDate.slice(0, 10)}). Real IDs replaced; amounts, field shapes and types kept. No buyer data, no bank details.`,
      payout: { payoutId: m("PAYOUT", p.payoutId), payoutStatus: p.payoutStatus, payoutDate: p.payoutDate, amount: p.amount, transactionCount: p.transactionCount },
      transactions: sanitised.transactions.map((t) => ({
        ...t,
        transactionId: m("TXN", t.transactionId),
        orderId: m("ORDER", t.orderId),
        payoutId: m("PAYOUT", t.payoutId),
        salesRecordReference: undefined,
        orderLineItems: t.orderLineItems?.map((li) => ({ ...li, lineItemId: m("LINE", li.lineItemId)! })),
        references: (t as { references?: { referenceId: string; referenceType: string }[] }).references?.map((r) => ({
          ...r,
          referenceId: m("REF", r.referenceId)!,
        })),
      })),
      orders: [...raw.orders.values()].map((o: EbayOrder) => ({
        ...(ebayOrderForAudit(o) as object),
        orderId: m("ORDER", o.orderId),
        salesRecordReference: null,
      })),
    };
    const dir = join(root, "test", "fixtures", "live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${fixtureName}.json`), JSON.stringify(fixture, null, 1) + "\n");
    console.log(`Masked fixture written: test/fixtures/live/${fixtureName}.json`);
  }
}

// ------------------------------------------------------------------- Shopify

async function shopify() {
  if (!env.SHOPIFY_SHOP) throw new Error("Set SHOPIFY_SHOP (or keep it in wrangler.toml)");
  const client = new ShopifyClient({
    shop: env.SHOPIFY_SHOP,
    token: env.SHOPIFY_ADMIN_TOKEN,
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    apiVersion: env.SHOPIFY_API_VERSION ?? "2026-10",
  });
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const payouts = (await client.listPayouts(since)).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  if (!arg || arg === "--scan") {
    for (const p of payouts) {
      const txns = await client.payoutTransactions(p.legacyResourceId);
      const types = new Map<string, number>();
      for (const t of txns) types.set(t.type, (types.get(t.type) ?? 0) + 1);
      console.log(`${p.legacyResourceId}  ${p.issuedAt.slice(0, 10)}  ${p.net.amount} ${p.net.currencyCode}  ${p.status}  ${[...types].map(([k, n]) => `${k}×${n}`).join(", ")}`);
    }
    return;
  }
  const p = payouts.find((x) => x.legacyResourceId === arg);
  if (!p) throw new Error(`Payout ${arg} not found in the last 30 days`);
  const raw = await client.fetchRaw(p);
  const payout = normaliseShopifyPayout(raw.payout, raw.transactions, raw.orders, raw.orderErrors);
  for (const d of client.deprecations) payout.warnings.push(`Deprecation: ${d}`);
  const v = await verify(payout);
  const rows: (string | number)[][] = [["Balance txn ID", "Type", "Order", "Amount", "Fee", "Net (contribution)", "Order total", "Currency", "Mapping notes"]];
  for (const t of raw.transactions) {
    const o = t.associatedOrder ? raw.orders.get(t.associatedOrder.id) : undefined;
    rows.push([
      t.id.replace("gid://shopify/ShopifyPaymentsBalanceTransaction/", ""),
      t.type,
      t.associatedOrder?.name ?? "",
      t.amount.amount,
      t.fee.amount,
      t.net.amount,
      o ? o.totalPriceSet.shopMoney.amount : "—",
      t.amount.currencyCode,
      [o && toCents(o.totalPriceSet.shopMoney.amount) !== toCents(t.amount.amount) && t.type === "CHARGE" ? "charge ≠ order total" : "", t.test ? "TEST" : ""].filter(Boolean).join("; "),
    ]);
  }
  const report = [`# Shopify Payments payout ${p.legacyResourceId} — live validation`, "", md(rows), "", summary(v.report, { ...v, rawCount: payout.raw.transactions.length })].join("\n");
  console.log(report);
  save(join(root, ".live", `shopify-${p.legacyResourceId}`), {
    "validation.md": report,
    "sanitised.json": JSON.stringify({ payout: p, transactions: raw.transactions, orders: [...raw.orders.values()] }, null, 1),
  });
  if (fixtureName) console.log("Shopify fixture masking: copy the sanitised JSON and replace the gid numbers; no buyer data is queried.");
}

if (channel === "ebay") await ebay();
else if (channel === "shopify") await shopify();
else console.log("Usage: live-validate.ts ebay|shopify [--scan | <payoutId> [--fixture <name>]]");

export type { EbayPayout, ShopifyPayout, ShopifyBalanceTxn, ShopifyOrder };
