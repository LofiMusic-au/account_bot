// Server-rendered dashboard. Plain HTML, no build step.

import { fmt } from "./money";
import { FEE_CATEGORIES, REPORT_VERSION, saleScenarioCounts, type PayoutReport } from "./reconcile";
import type { ReportSummary, SourceInfo } from "./db";
import type { Channel, FeeCategory, Issue, LineClassification, SourceRef } from "./types";
import { CATEGORIES, HISTORICAL_BASELINE, type LogicalCategory } from "./accounting/categories";
import { periodTotals } from "./accounting/consignment";
import type { ConsignmentRow } from "./db";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  needs_review: "Needs review",
  unbalanced: "Doesn't balance",
};
const FEE_LABEL: Record<FeeCategory, string> = {
  marketplace: "Marketplace fees",
  payment: "Payment processing fees",
  advertising: "Advertising / promoted listing fees",
  shipping_label: "Shipping labels",
  other: "Other fees",
};
const ISSUE_LABEL: Record<string, string> = {
  unknown_sku: "Line has no SKU",
  unknown_stock_record: "Unknown stock record",
  unknown_ownership: "Ownership unknown",
  unknown_acquisition_source: "Acquisition source unknown",
  unknown_condition: "New or second-hand unknown",
  unknown_supplier_gst_status: "Supplier GST status unknown",
  unknown_consignor: "Consignor unknown",
  unknown_consignor_gst_status: "Consignor's Australian GST registration unknown",
  unknown_consignor_agreement: "Consignment agreement type unknown",
  unknown_commission: "Commission rate unknown",
  unknown_purchase_price: "Purchase price unknown",
  unknown_destination: "Destination unknown",
  unresolved_scenario: "Treatment not decided",
  manual_review: "Needs a person",
  unknown_fee_tax: "Fee GST treatment pending",
  unsigned_scenario: "Scenario not signed off",
  fx_policy_pending: "Foreign-currency policy pending",
  payout_mismatch: "Payout doesn't match",
  unsupported_transaction_type: "Unsupported transaction type",
  dispute: "Dispute / chargeback",
  order_details_missing: "Order details missing",
  sale_amount_mismatch: "Sale amount doesn't match order",
  order_lines_mismatch: "Order lines don't add up",
  refund_unmatched: "Refund not matched to a sale",
  non_aud_transaction: "Not in AUD",
  test_transaction: "Test transaction",
  transaction_in_other_payout: "Transaction already in another payout",
};

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--card:#fff;--good:#1f7a4d;--warn:#a15c00;--bad:#b3261e;--accent:#2f5bd3;--warnbg:#fff6e6}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#a3a29b;--line:#2f2e2b;--card:#1f1f1d;--good:#5cc98f;--warn:#f0a94b;--bad:#f2766d;--accent:#8aa8ff;--warnbg:#2b2214}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header b{font-size:15px}header a{color:var(--muted);text-decoration:none}header a:hover{color:var(--fg)}
main{max-width:1240px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0 4px}h2{font-size:15px;margin:28px 0 8px}
.muted{color:var(--muted)}.small{font-size:12px}.note{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:12px 0}
.banner{background:var(--warnbg);border:1px solid var(--warn);border-radius:8px;padding:10px 12px;margin:12px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:12px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.tile .v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:0}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}tr.total td{font-weight:600}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid currentColor;white-space:nowrap;margin:1px 2px 1px 0}
.ready,.approved{color:var(--good)}.needs_review,.draft,.signoff,.provisional{color:var(--warn)}.unbalanced,.review,.blocking{color:var(--bad)}
.flags{margin:4px 0 0;padding-left:16px;color:var(--muted);font-size:12px}
details summary{cursor:pointer;color:var(--accent);font-size:12px}details ol{margin:4px 0;padding-left:18px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
a{color:var(--accent)}button,input,select{font:inherit}
button{background:var(--fg);color:var(--bg);border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
button.alt{background:transparent;color:var(--fg);border:1px solid var(--line)}
form.inline{display:inline-flex;gap:6px;flex-wrap:wrap;align-items:center;margin:2px 0}
form.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}
input,select{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
input.cc{width:4.5em}
form.factform{display:flex;flex-wrap:wrap;gap:6px;align-items:center}form.factform select{max-width:13em}
input.money{width:7em}input.pct{width:5em}details.prefix{flex-basis:100%}details.prefix summary{font-size:12px}
label.inline{display:inline-flex;flex-direction:row;align-items:center;gap:6px;color:var(--fg)}
</style></head><body>
<header><b>LOFI payout reconciliation</b><a href="/">Payouts</a><a href="/review">Review queue</a><a href="/consignments">Consignments (shadow)</a><a href="/stock/new">Add stock record</a>
<span class="muted" style="margin-left:auto">Report-only · nothing is posted to QuickBooks</span></header>
<main>${body}</main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const chip = (cls: string, label: string) => `<span class="chip ${esc(cls)}">${esc(label)}</span>`;
const channelName = (c: string) => (c === "ebay" ? "eBay" : c === "shopify" ? "Shopify" : c);
const payoutLink = (channel: string, id: string) => `/payout/${esc(channel)}/${encodeURIComponent(id)}`;
const statusChips = (status: string, provisional: boolean) =>
  chip(status, STATUS_LABEL[status] ?? status) + (provisional ? chip("provisional", "Provisional") : "");
const message = (m?: string) => (m ? `<div class="note">${esc(m)}</div>` : "");
/** All / eBay / Shopify toggle for a page. */
const channelToggle = (base: string, current?: Channel) => {
  const opt = (c: Channel | undefined, label: string) =>
    c === current
      ? `<span class="chip ready" aria-current="true">${label}</span>`
      : `<a class="chip" style="color:var(--muted);text-decoration:none" href="${base}${c ? `?channel=${c}` : ""}">${label}</a>`;
  return `<div style="margin:8px 0" role="group" aria-label="Filter by platform">${opt(undefined, "All")} ${opt("ebay", "eBay")} ${opt("shopify", "Shopify")}</div>`;
};

const clearButton = (canReset: boolean) =>
  canReset
    ? `<form method="post" action="/admin/clear-payouts" style="display:inline" onsubmit="return confirm('Delete every payout and its stored source data? Stock records, consignors and facts are kept. You can fetch payouts again afterwards.')"><button class="alt">Clear all payouts</button></form>`
    : "";

export function renderIndex(rows: ReportSummary[], msg?: string, canReset = false, channel?: Channel): Response {
  const body = `
<h1>Payouts</h1>
<p class="muted">Each payout is rebuilt into its sales, fees, refunds and adjustments, GST is worked out per LOFI's draft scenarios, and the total is checked against the actual payout to the cent.
<b>Provisional</b> means at least one treatment used isn't signed off by the accountant yet.</p>
${message(msg)}
<div style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap"><form method="post" action="/run" style="display:inline"><button>Fetch new payouts now</button></form>${clearButton(canReset)}</div>
${channelToggle("/", channel)}
<div class="wrap"><table>
<tr><th>Date</th><th>Channel</th><th>Payout</th><th class="n">Actual payout</th><th class="n">Reconstructed</th><th class="n">Difference</th><th class="n">Sales</th><th>Scenarios</th><th>Status</th></tr>
${rows
  .map((r) => {
    let mix: [string, number][] = [];
    try {
      mix = r.scenario_summary ? (JSON.parse(r.scenario_summary) as [string, number][]) : [];
    } catch {
      /* older row */
    }
    return `<tr><td>${esc(r.payout_date)}</td><td>${channelName(r.channel)}</td>
<td><a href="${payoutLink(r.channel, r.payout_id)}">${esc(r.payout_id)}</a></td>
<td class="n">${fmt(r.net_cents)}</td><td class="n">${fmt(r.expected_cents)}</td>
<td class="n">${r.difference_cents === 0 ? "$0.00" : `<span class="unbalanced">${fmt(r.difference_cents)}</span>`}</td>
<td class="n">${r.sale_count}</td>
<td class="small">${mix.map(([c, n]) => `${esc(c)} ×${n}`).join(" · ")}</td>
<td>${statusChips(r.status, r.provisional === 1)}${r.blocking_count ? ` <span class="muted small">${r.blocking_count} to fix</span>` : ""}</td></tr>`;
  })
  .join("")}
${rows.length === 0 ? `<tr><td colspan="9" class="muted">${channel ? `No ${channelName(channel)} payouts yet.` : `No payouts yet. Press "Fetch new payouts now".`}</td></tr>` : ""}
</table></div>`;
  return page("Payouts", body);
}

const sourceIds = (sources: SourceRef[]) =>
  sources
    .map((s) => `<code>${esc(s.transactionType ?? "")} ${esc(s.transactionId ?? "")}</code>${s.rawAmount ? ` <span class="muted">${esc(s.rawAmount)} ${esc(s.rawCurrency)}</span>` : ""}`)
    .join("<br>");

function linesTable(lines: LineClassification[]): string {
  if (lines.length === 0) return `<p class="muted">None.</p>`;
  return `<div class="wrap"><table>
<tr><th>Order</th><th>SKU</th><th>Item and reason</th><th>Scenario</th><th>Status</th><th class="n">Amount</th><th class="n">Discount</th><th class="n">GST</th><th class="n">Div 66 credit</th><th>Postings (proposed)</th><th>Source</th></tr>
${lines
  .map(
    (l) => `<tr><td>${esc(l.orderName)}</td><td>${l.sku ? `<code>${esc(l.sku)}</code>` : `<span class="muted">—</span>`}</td>
<td>${esc(l.title)}<div class="muted small">${esc(l.reason)}</div>
${l.explanation?.length ? `<details><summary>Why ${esc(l.scenario)}?</summary><ol>${l.explanation.map((e) => `<li>${esc(e)}</li>`).join("")}</ol></details>` : ""}
${l.flags.length ? `<ul class="flags">${l.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}</td>
<td>${esc(l.scenario)}${l.division66Candidate ? `<div class="small muted">Div 66</div>` : ""}</td><td>${chip(l.approval, l.approval)}</td>
<td class="n">${fmt(l.grossCents)}</td><td class="n">${l.discountCents ? fmt(l.discountCents) : ""}</td><td class="n">${fmt(l.gstCents)}</td>
<td class="n">${l.notionalItcCents ? fmt(l.notionalItcCents) : ""}</td>
<td class="small">${l.postings.map((p) => `${esc(p.account)} · ${esc(p.taxCode)} · ${fmt(p.grossCents)}`).join("<br>")}</td>
<td class="small">${sourceIds(l.sources ?? [])}</td></tr>`,
  )
  .join("")}
</table></div>`;
}

/** The buttons that let staff record the missing fact behind an issue. */
export function fixFor(issue: Issue, channel: string, title: string | null, back: string, consignorName?: string): string {
  const hidden = (k: string, v: unknown) => `<input type="hidden" name="${k}" value="${esc(v)}">`;
  const factButtons = (field: string, options: [string, string][]) =>
    issue.sku
      ? `<form class="inline" method="post" action="/facts/stock">${hidden("sku", issue.sku)}${hidden("field", field)}${hidden("title", title ?? "")}${hidden("return", back)}
${options.map(([v, label]) => `<button class="alt" name="value" value="${esc(v)}">${esc(label)}</button>`).join("")}</form>`
      : "";
  const stockForm = issue.sku
    ? ` <a class="small" href="/stock/new?sku=${encodeURIComponent(issue.sku)}&title=${encodeURIComponent(title ?? "")}">Full stock record</a>`
    : "";
  switch (issue.code) {
    case "unknown_stock_record":
      return `<div class="small muted">Ownership?</div>${factButtons("ownership", [["owned", "LOFI"], ["consignment", "Consignment"]])}${stockForm}`;
    case "unknown_acquisition_source":
      return `<div class="small muted">Acquired from?</div>${factButtons("acquired_from", [
        ["registered_supplier", "GST-registered supplier"],
        ["private_seller", "Private / non-GST seller"],
        ["trade_in", "Trade-in"],
        ["other", "Other"],
      ])}${stockForm}`;
    case "unknown_condition":
      return `<div class="small muted">Condition when bought?</div>${factButtons("item_condition", [["new", "New"], ["secondhand", "Second-hand"]])}${stockForm}`;
    case "unknown_consignor_gst_status":
      return issue.consignorId
        ? `<div class="small muted">Is ${esc(consignorName ?? `consignor #${issue.consignorId}`)} registered for <b>Australian</b> GST?</div>
<form class="inline" method="post" action="/facts/consignor">${hidden("id", issue.consignorId)}${hidden("return", back)}
<button class="alt" name="gst" value="registered">Registered</button><button class="alt" name="gst" value="not_registered">Not registered</button></form>`
        : "";
    case "unknown_consignor_agreement":
      return issue.consignorId
        ? `<div class="small muted">Which arrangement does LOFI's written agreement with ${esc(consignorName ?? `consignor #${issue.consignorId}`)} set up?</div>
<form class="inline" method="post" action="/facts/consignor">${hidden("id", issue.consignorId)}${hidden("return", back)}
<button class="alt" name="agreement" value="agency">Ordinary agency</button><button class="alt" name="agreement" value="153B">Subdivision 153-B</button></form>`
        : "";
    case "unknown_destination":
      return issue.orderId
        ? `<div class="small muted">Where did the goods go?</div>
<form class="inline" method="post" action="/facts/order">${hidden("channel", channel)}${hidden("order_id", issue.orderId)}${hidden("return", back)}
<button class="alt" name="country" value="AU">Australia / local pickup</button></form>
<form class="inline" method="post" action="/facts/order">${hidden("channel", channel)}${hidden("order_id", issue.orderId)}${hidden("return", back)}
<input class="cc" name="country" placeholder="NZ" maxlength="2" required><button class="alt">Overseas</button></form>`
        : "";
    case "unknown_sku":
    case "unknown_consignor":
    case "unknown_commission":
    case "unknown_purchase_price":
    case "manual_review":
      return stockForm;
    default:
      return "";
  }
}

function issuesTable(r: PayoutReport, consignors: Map<number, string>, back: string): string {
  if (!r.issues?.length) return `<p class="muted">None.</p>`;
  const titleFor = (i: Issue) => [...r.sales, ...r.refunds].find((l) => l.lineId === i.lineId)?.title ?? null;
  return `<div class="wrap"><table><tr><th>Type</th><th>Issue</th><th class="n">Amount</th><th>Fix</th></tr>
${r.issues
  .map(
    (i) => `<tr><td>${chip(i.severity, i.severity === "blocking" ? "Blocking" : "Awaiting sign-off")}<div class="small">${esc(ISSUE_LABEL[i.code] ?? i.code)}</div></td>
<td>${esc(i.message)}${i.transactionId ? `<div class="small muted">Transaction <code>${esc(i.transactionId)}</code></div>` : ""}</td>
<td class="n">${i.cents !== undefined ? fmt(i.cents) : ""}</td>
<td>${i.severity === "blocking" ? fixFor(i, r.channel, titleFor(i), back, i.consignorId ? consignors.get(i.consignorId) : undefined) : `<span class="muted small">Accountant</span>`}</td></tr>`,
  )
  .join("")}
</table></div>`;
}

export function renderReport(r: PayoutReport, src: SourceInfo | null, msg?: string, consignors = new Map<number, string>()): Response {
  if (r.version !== REPORT_VERSION || !r.breakdown) {
    return page(
      `Payout ${r.payoutId}`,
      `<p class="muted"><a href="/">← Payouts</a></p><h1>${channelName(r.channel)} payout ${esc(r.payoutId)}</h1>
<div class="banner">This report was made by an older version. Fetch it again to see the current detail.</div>
<form method="post" action="${payoutLink(r.channel, r.payoutId)}/refetch"><button>Fetch again from ${channelName(r.channel)}</button></form>`,
    );
  }
  const t = r.totals;
  const b = r.breakdown;
  const back = payoutLink(r.channel, r.payoutId);
  const itemLines = r.sales.filter((l) => l.kind === "item");
  const scenarioCounts = saleScenarioCounts(r);
  const body = `
<p class="muted"><a href="/">← Payouts</a></p>
<h1>${channelName(r.channel)} payout ${esc(r.payoutId)} — ${esc(r.payoutDate)}</h1>
<p>${statusChips(r.status, r.provisional)} <span class="muted small">· generated ${esc(r.generatedAt.slice(0, 16).replace("T", " "))} UTC</span></p>
${message(msg)}
${r.provisional ? `<div class="banner"><b>Provisional.</b> Every GST treatment here is a draft until the accountant signs it off. Nothing is posted to QuickBooks.</div>` : ""}
<div class="tiles">
<div class="tile"><div class="muted">Actual payout</div><div class="v">${fmt(r.netCents)}</div><div class="small muted">${esc(r.rawAmount)} ${esc(r.rawCurrency)} as sent</div></div>
<div class="tile"><div class="muted">Reconstructed</div><div class="v">${fmt(r.expectedCents)}</div></div>
<div class="tile"><div class="muted">Difference</div><div class="v ${r.differenceCents ? "unbalanced" : "ready"}">${fmt(r.differenceCents)}</div></div>
<div class="tile"><div class="muted">GST on sales (draft)</div><div class="v">${fmt(t.gstCents)}</div></div>
<div class="tile"><div class="muted">Division 66 credits (draft)</div><div class="v">${fmt(t.notionalItcCents)}</div></div>
</div>
<p><b>${r.saleCount} sales</b>, ${itemLines.length} item lines${scenarioCounts.length ? ": " : ""}${scenarioCounts
    .map(([code, n]) => `${n} ${esc(code)}${code === "REVIEW" ? " unresolved" : ""}`)
    .join(" · ")}${r.refunds.length ? ` · ${r.refunds.filter((l) => l.kind === "item").length} refunded line(s)` : ""}${r.blockingCount ? ` · <span class="review">${r.blockingCount} to fix</span>` : ""}</p>
<form class="inline" method="post" action="${back}/rebuild"><button class="alt">Rebuild with latest facts</button></form>
<form class="inline" method="post" action="${back}/refetch"><button class="alt">Fetch again from ${channelName(r.channel)}</button></form>

<h2>Issues</h2>${issuesTable(r, consignors, back)}

<h2>How the payout is made up</h2>
<div class="wrap"><table>
<tr><th></th><th class="n">Amount</th></tr>
<tr><td>Items sold, after discounts${b.discountsCents ? ` <span class="muted small">(${fmt(b.discountsCents)} of discounts already taken off)</span>` : ""}</td><td class="n">${fmt(b.itemsCents)}</td></tr>
<tr><td>Shipping charged to buyers</td><td class="n">${fmt(b.shippingCents)}</td></tr>
<tr><td>Refunds</td><td class="n">${fmt(-b.refundsCents)}</td></tr>
${FEE_CATEGORIES.map((c) => `<tr><td>${FEE_LABEL[c]}</td><td class="n">${fmt(-b.feesByCategory[c])}</td></tr>`).join("")}
<tr><td>Adjustments</td><td class="n">${fmt(b.adjustmentsCents)}</td></tr>
${b.unsupportedCents ? `<tr><td class="review">Unsupported transaction types (counted, need review)</td><td class="n">${fmt(b.unsupportedCents)}</td></tr>` : ""}
<tr class="total"><td>Reconstructed payout</td><td class="n">${fmt(r.expectedCents)}</td></tr>
<tr><td>Actual payout</td><td class="n">${fmt(r.netCents)}</td></tr>
<tr class="total"><td>Difference</td><td class="n ${r.differenceCents ? "unbalanced" : "ready"}">${fmt(r.differenceCents)}</td></tr>
</table></div>
${r.warnings.length ? `<h2>Notes</h2><div class="note"><ul style="margin:0;padding-left:18px">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}

${baselineSection(r)}

<h2>By draft GST scenario</h2>
<div class="wrap"><table><tr><th>Scenario</th><th>Sign-off</th><th class="n">Lines</th><th class="n">Amount</th><th class="n">GST</th></tr>
${t.byScenario.map((s) => `<tr><td><b>${esc(s.code)}</b> ${esc(s.name)}</td><td>${s.code === "REVIEW" ? chip("review", "review") : s.signedOff ? chip("approved", "signed off") : chip("draft", "draft")}</td><td class="n">${s.count}</td><td class="n">${fmt(s.grossCents)}</td><td class="n">${fmt(s.gstCents)}</td></tr>`).join("")}
</table></div>
<h2>Sales</h2>${linesTable(r.sales)}
<h2>Refunds</h2>${linesTable(r.refunds)}
<h2>Fees</h2>
${r.fees.length ? `<div class="wrap"><table><tr><th>Category</th><th>Type</th><th>Description</th><th>GST treatment</th><th class="n">Amount</th><th>Source</th></tr>
${r.fees.map((f) => `<tr><td>${esc(FEE_LABEL[f.category] ?? f.category)}</td><td>${esc(f.type)}</td><td>${esc(f.description)}</td><td>${f.taxCode === "PENDING" ? chip("draft", "pending") : esc(f.taxCode)}</td><td class="n">${fmt(f.cents)}</td><td class="small">${sourceIds([f.source])}</td></tr>`).join("")}</table></div>` : `<p class="muted">None.</p>`}
<h2>Adjustments</h2>
${r.adjustments.length ? `<div class="wrap"><table><tr><th>Type</th><th>Description</th><th></th><th class="n">Amount</th><th>Source</th></tr>
${r.adjustments.map((a) => `<tr><td>${esc(a.type)}</td><td>${esc(a.description)}</td><td>${a.supported ? "" : chip("review", "unsupported")}</td><td class="n">${fmt(a.cents)}</td><td class="small">${sourceIds([a.source])}</td></tr>`).join("")}</table></div>` : `<p class="muted">None.</p>`}
<h2>Source data</h2>
<div class="note small">${
    src
      ? `${src.transaction_count} platform transactions stored. First fetched ${esc(src.first_ingested_at)}, last fetched ${esc(src.last_ingested_at)} (${src.fetch_count} fetch${src.fetch_count === 1 ? "" : "es"}).${
          src.changed_transactions ? ` <span class="review">${src.changed_transactions} transaction(s) changed between fetches.</span>` : ""
        }`
      : "No stored source data (demo or older report)."
  }</div>`;
  return page(`Payout ${r.payoutId}`, body);
}

function baselineSection(r: PayoutReport): string {
  const b = r.baseline;
  if (!b) return "";
  const order: LogicalCategory[] = ["SALES_DOMESTIC_GST", "SALES_OVERSEAS_NO_GST", "CONSIGNMENT_SALES_NO_GST", "REFUND", "EBAY_FEES", "SHOPIFY_FEES", "MARKETPLACE_ADJUSTMENTS", "UNCLASSIFIED"];
  const rows = order
    .filter((c) => b.totals[c] !== undefined)
    .map((c) => {
      const def = CATEGORIES[c];
      const refundDetail =
        c === "REFUND"
          ? `<div class="muted small">${[...new Set(b.lines.filter((l) => l.category === "REFUND").map((l) => l.reversesCategory))].map((x) => `reverses ${esc(x)}`).join(", ")}</div>`
          : "";
      return `<tr><td><b>${esc(c)}</b> <span class="muted small">${esc(def.label)}</span>${refundDetail}</td><td class="small">${esc(def.historicalAccount ?? "—")}</td><td class="n ${c === "UNCLASSIFIED" ? "review" : ""}">${fmt(b.totals[c]!)}</td></tr>`;
    })
    .join("");
  return `<h2>Historical baseline split</h2>
<p class="muted small">How staff split this payout by hand: by ownership and destination only. Consignment sales go in full at no GST, and their commission is handled in the consignment ledger. Jess's manual ledger is the source of truth for that; the <a href="/consignments">shadow ledger</a> here is a comparison only. This is LOFI's current method, <b>not</b> an accountant-approved treatment. ${b.complete ? `<span class="ready">Every line is categorised.</span>` : `<span class="review">${b.unclassifiedCount} line(s) not categorised yet.</span>`}</p>
<div class="wrap"><table><tr><th>Category</th><th>Historical QuickBooks account</th><th class="n">Amount</th></tr>${rows}
<tr class="total"><td>Total (equals the reconstructed payout)</td><td></td><td class="n">${fmt(b.sumCents)}</td></tr></table></div>`;
}

export function renderConsignments(rows: ConsignmentRow[], period: string | undefined, periods: string[]): Response {
  const totals = periodTotals(
    rows.map((r) => ({
      accountingPeriod: r.accounting_period,
      consignorId: r.consignor_id,
      consignorName: r.consignor_name,
      status: r.status === "calculated" ? ("calculated" as const) : ("incomplete" as const),
      grossSaleCents: r.gross_sale_cents,
      commissionCents: r.commission_cents,
      commissionGstCents: r.commission_gst_cents,
      consignorPayableCents: r.consignor_payable_cents,
    })),
  );
  const byPeriod = new Map<string, typeof totals>();
  for (const t of totals) byPeriod.set(t.period, [...(byPeriod.get(t.period) ?? []), t]);
  const periodLinks = `<div style="margin:8px 0">${[undefined, ...periods]
    .map((p) =>
      p === period
        ? `<span class="chip ready">${p ?? "All periods"}</span>`
        : `<a class="chip" style="color:var(--muted);text-decoration:none" href="/consignments${p ? `?period=${p}` : ""}">${p ?? "All periods"}</a>`,
    )
    .join(" ")}</div>`;
  const sum = (ts: typeof totals, k: "grossSaleCents" | "commissionCents" | "commissionGstCents" | "commissionExGstCents" | "consignorPayableCents") =>
    ts.reduce((a, t) => a + t[k], 0);
  const periodBlocks = [...byPeriod]
    .map(
      ([p, ts]) => `<h2>${esc(p)}</h2>
<div class="tiles">
<div class="tile"><div class="muted">Consignment sales</div><div class="v">${fmt(sum(ts, "grossSaleCents"))}</div></div>
<div class="tile"><div class="muted">Provisional LOFI commission (ex GST)</div><div class="v">${fmt(sum(ts, "commissionExGstCents"))}</div></div>
<div class="tile"><div class="muted">Provisional GST on commission</div><div class="v">${fmt(sum(ts, "commissionGstCents"))}</div></div>
<div class="tile"><div class="muted">Provisional consignor share</div><div class="v">${fmt(sum(ts, "consignorPayableCents"))}</div></div>
</div>
<p class="muted small">Shadow figures to compare with Jess's ledger for the period. Not for payouts or journals.${
        ts.some((t) => t.incomplete) ? ` <span class="review">${ts.reduce((a, t) => a + t.incomplete, 0)} entr${ts.reduce((a, t) => a + t.incomplete, 0) === 1 ? "y is" : "ies are"} incomplete and not included.</span>` : ""
      }</p>
<div class="wrap"><table><tr><th>Consignor</th><th class="n">Entries</th><th class="n">Sales</th><th class="n">Commission</th><th class="n">GST on commission</th><th class="n">Consignor share (provisional)</th></tr>
${ts
  .map(
    (t) => `<tr><td>${esc(t.consignorName ?? "No consignor recorded")}</td><td class="n">${t.entries}${t.incomplete ? ` <span class="review small">(${t.incomplete} incomplete)</span>` : ""}</td>
<td class="n">${fmt(t.grossSaleCents)}</td><td class="n">${fmt(t.commissionCents)}</td><td class="n">${fmt(t.commissionGstCents)}</td><td class="n">${fmt(t.consignorPayableCents)}</td></tr>`,
  )
  .join("")}</table></div>`,
    )
    .join("");
  const detail = `<h2>Entries</h2><div class="wrap"><table><tr><th>Date</th><th>Order</th><th>SKU</th><th>Consignor</th><th>Rule</th><th class="n">Sale</th><th class="n">Commission</th><th class="n">GST</th><th class="n">Consignor share</th><th>Status</th></tr>
${rows
  .map(
    (r) => `<tr><td>${esc(r.sale_date)}${r.kind === "refund" ? ` ${chip("review", "refund")}` : ""}</td>
<td><a href="${payoutLink(r.channel, r.payout_id)}">${esc(r.order_name ?? "")}</a></td><td><code>${esc(r.sku ?? "")}</code></td>
<td>${esc(r.consignor_name ?? "—")}</td><td class="small">${r.commission_type === "percent" ? `${r.commission_value}%` : r.commission_type === "fixed" ? `$${r.commission_value} each` : "—"}</td>
<td class="n">${fmt(r.gross_sale_cents)}</td><td class="n">${r.commission_cents === null ? "" : fmt(r.commission_cents)}</td>
<td class="n">${r.commission_gst_cents === null ? "" : fmt(r.commission_gst_cents)}</td><td class="n">${r.consignor_payable_cents === null ? "" : fmt(r.consignor_payable_cents)}</td>
<td>${r.status === "calculated" ? chip("draft", "provisional") : `${chip("review", "incomplete")}<div class="small muted">${esc(r.problem ?? "")}</div>`}</td></tr>`,
  )
  .join("")}
${rows.length === 0 ? `<tr><td colspan="10" class="muted">No consignment sales yet. They appear here automatically when a payout includes a consigned item.</td></tr>` : ""}</table></div>`;
  const body = `<h1>Consignment ledger <span class="chip draft">SHADOW MODE</span></h1>
<div class="banner"><b>Consignment module — shadow mode.</b> Jess's manual consignment ledger is the source of truth. Everything on this page is provisional and non-authoritative. Don't use it for consignor payouts, GST journals or liability balances. It runs alongside so its results can be compared with Jess's ledger before any switch-over.</div>
<p class="muted">A draft of the consignment spreadsheet, filled from the same sales as the payout reconciler. Every consigned item in a payout appears here automatically. Each consignor's rule is applied: commission = rule × sale price after discounts, excluding shipping. GST on commission is 1/11 of the commission, and the consignor is paid the rest. The payout split records the full sale as <b>CONSIGNMENT_SALES_NO_GST</b>, and this ledger supplies the commission figures for the period's journal. ${esc(HISTORICAL_BASELINE.label)}.</p>
${periodLinks}${periodBlocks}${detail}`;
  return page("Consignments", body);
}

export interface ReviewItem {
  report: PayoutReport;
  issue: Issue;
}

/** Which part of the queue an issue belongs to. */
export type IssueGroup = "facts" | "integration" | "accounting";
const FACT_CODES = new Set([
  "unknown_sku",
  "unknown_stock_record",
  "unknown_ownership",
  "unknown_acquisition_source",
  "unknown_condition",
  "unknown_supplier_gst_status",
  "unknown_consignor",
  "unknown_consignor_gst_status",
  "unknown_consignor_agreement",
  "unknown_commission",
  "unknown_purchase_price",
  "unknown_destination",
]);
const ACCOUNTING_CODES = new Set(["unresolved_scenario", "manual_review", "dispute"]);
export const issueGroup = (i: Issue): IssueGroup =>
  FACT_CODES.has(i.code) ? "facts" : ACCOUNTING_CODES.has(i.code) ? "accounting" : "integration";
/** SKU-level fact problems are fixed with one form per SKU. */
const SKU_FORM_CODES = new Set(["unknown_stock_record", "unknown_acquisition_source", "unknown_condition", "unknown_purchase_price", "unknown_consignor", "unknown_commission"]);

/** A sensible prefix to suggest for a SKU: up to and including its first separator. */
export function suggestPrefix(sku: string): string {
  const m = /^(.+?[-_/])./.exec(sku);
  return m && m[1]!.length >= 2 ? m[1]! : "";
}

export interface ReviewData {
  /** Every recent report for the selected platform(s), for the summary. */
  reports: PayoutReport[];
  consignors: ConsignorOption[];
  /** Current facts for SKUs in the queue, keyed by upper-case SKU. */
  items: Map<string, StockRowLike>;
  prefixes: PrefixRowLike[];
}
export interface StockRowLike {
  sku: string;
  ownership: string;
  acquired_from: string | null;
  item_condition?: string | null;
  purchase_cents: number | null;
  consignor_id: number | null;
  commission_value: number | null;
}
export interface PrefixRowLike {
  prefix: string;
  ownership: string;
  acquired_from: string | null;
  item_condition?: string | null;
  consignor_id: number | null;
}

interface Group {
  key: string;
  group: IssueGroup;
  issues: Issue[];
  sku: string | null;
  title: string | null;
  channel: string;
  reports: PayoutReport[];
  cents: number;
}

const groupKey = (r: PayoutReport, i: Issue) => {
  if (i.sku && SKU_FORM_CODES.has(i.code)) return `sku|${i.sku.toUpperCase()}`;
  if (i.code === "unknown_destination") return `dest|${r.channel}|${i.orderId}`;
  if (i.consignorId) return `${i.code}|c|${i.consignorId}`;
  if (i.sku) return `${i.code}|sku|${i.sku.toUpperCase()}`;
  return `${i.code}|${r.channel}|${r.payoutId}|${i.orderId ?? ""}|${i.transactionId ?? ""}|${i.message}`;
};

function factForm(g: Group, d: ReviewData, back: string, skusInQueue: string[]): string {
  const sku = g.sku!;
  const cur = d.items.get(sku.toUpperCase());
  const pre = cur
    ? null
    : [...d.prefixes].sort((a, b) => b.prefix.length - a.prefix.length).find((p) => sku.toUpperCase().startsWith(p.prefix.toUpperCase())) ?? null;
  const v = {
    ownership: cur?.ownership ?? pre?.ownership ?? "",
    acquired_from: cur?.acquired_from ?? pre?.acquired_from ?? "",
    item_condition: cur?.item_condition ?? pre?.item_condition ?? "",
    purchase: cur?.purchase_cents != null ? fmt(cur.purchase_cents).replace(/[$,]/g, "") : "",
    consignor_id: String(cur?.consignor_id ?? pre?.consignor_id ?? ""),
    commission: cur?.commission_value != null ? String(cur.commission_value) : "",
  };
  const sel = (name: string, current: string, opts: [string, string][]) =>
    `<select name="${name}" aria-label="${name.replace("_", " ")}">${opts.map(([val, label]) => `<option value="${esc(val)}"${val === current ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  const suggestion = suggestPrefix(sku);
  const others = suggestion ? skusInQueue.filter((x) => x.toUpperCase() !== sku.toUpperCase() && x.toUpperCase().startsWith(suggestion.toUpperCase())).length : 0;
  const hidden = (k: string, val: unknown) => `<input type="hidden" name="${k}" value="${esc(val)}">`;
  return `<form class="factform" method="post" action="/facts/item">${hidden("sku", sku)}${hidden("title", g.title ?? "")}${hidden("return", back)}
${sel("ownership", v.ownership, [["", "Ownership?"], ["owned", "LOFI-owned"], ["consignment", "Consignment"]])}
${sel("acquired_from", v.acquired_from, [["", "Acquired from?"], ["registered_supplier", "GST-registered supplier"], ["private_seller", "Private / non-GST seller"], ["trade_in", "Trade-in"], ["other", "Other"]])}
${sel("item_condition", v.item_condition, [["", "Condition?"], ["new", "New"], ["secondhand", "Second-hand"]])}
<input name="purchase_aud" inputmode="decimal" placeholder="Purchase $" value="${esc(v.purchase)}" aria-label="Purchase price" class="money">
${sel("consignor_id", v.consignor_id, [
  ["", "Consignor (if consigned)"],
  ...d.consignors.map((c): [string, string] => [
    String(c.id),
    `${c.name}${c.country ? ` · ${c.country}` : ""}${c.commission_value != null ? ` · ${c.commission_type === "fixed" ? `$${c.commission_value} each` : `${c.commission_value}%`}` : ""}`,
  ]),
])}
<a class="small" href="/stock/new#new-consignor">+ New consignor</a>
<input name="commission" inputmode="decimal" placeholder="Comm. % (blank = consignor's rule)" value="${esc(v.commission)}" aria-label="Commission percent override" class="pct" style="width:15em">
<button>Save</button>
${
  suggestion
    ? `<details class="prefix"><summary>Also apply to every SKU starting with…</summary>
<label class="inline"><input type="checkbox" name="make_prefix" value="1"> Make a rule for SKUs starting with <input name="prefix" value="${esc(suggestion)}" size="8" aria-label="Prefix"></label>
<span class="muted small">${others ? `${others} other SKU${others === 1 ? "" : "s"} in this queue start with "${esc(suggestion)}".` : "No other SKUs in this queue match yet."} The rule sets ownership, source, condition and consignor; never a purchase price. An item's own record always wins.</span>
<label class="inline small"><input type="checkbox" name="replace" value="1"> Replace an existing rule for this prefix</label></details>`
    : ""
}
${cur ? `<div class="muted small">Editing the record for ${esc(sku)}.</div>` : pre ? `<div class="muted small">Currently from SKU prefix rule "${esc(pre.prefix)}".</div>` : ""}
</form>`;
}

export function renderReview(d: ReviewData, msg?: string, canReset = false, channel?: Channel): Response {
  const back = channel ? `/review?channel=${channel}` : "/review";
  const consignorNames = new Map(d.consignors.map((c) => [c.id, c.name]));
  const open = d.reports.filter((r) => r.status !== "ready");

  // Group blocking issues: one row per distinct fix.
  const groups = new Map<string, Group>();
  const reportKeys = new Map<PayoutReport, Set<string>>();
  for (const r of open) {
    const keys = new Set<string>();
    for (const i of r.issues ?? []) {
      if (i.severity !== "blocking") continue;
      const key = groupKey(r, i);
      keys.add(key);
      const line = [...r.sales, ...r.refunds].find((l) => l.lineId === i.lineId);
      const g = groups.get(key) ?? { key, group: issueGroup(i), issues: [], sku: i.sku ?? null, title: null, channel: r.channel, reports: [], cents: 0 };
      if (!g.issues.some((x) => x.code === i.code && x.message === i.message)) g.issues.push(i);
      g.title ??= line?.title ?? null;
      g.cents += line ? Math.abs(line.grossCents) : Math.abs(i.cents ?? 0);
      if (!g.reports.includes(r)) g.reports.push(r);
      groups.set(key, g);
    }
    reportKeys.set(r, keys);
  }
  // "Fixing this makes a payout ready": it's the only thing blocking it.
  const unblocks = (g: Group) => g.reports.filter((r) => r.status === "needs_review" && [...(reportKeys.get(r) ?? [])].every((k) => k === g.key));

  const all = [...groups.values()];
  const by = (grp: IssueGroup) => all.filter((g) => g.group === grp).sort((a, b) => unblocks(b).length - unblocks(a).length || b.cents - a.cents);
  const skusInQueue = all.filter((g) => g.sku).map((g) => g.sku!);
  const signoffTypes = new Set(d.reports.flatMap((r) => (r.issues ?? []).filter((i) => i.severity === "signoff").map((i) => i.code + i.message.slice(0, 40))));
  const count = (st: string) => d.reports.filter((r) => r.status === st).length;

  const tile = (label: string, value: number | string, cls = "") => `<div class="tile"><div class="muted">${label}</div><div class="v ${cls}">${value}</div></div>`;
  const summary = `<div class="tiles">
${tile("Payouts", d.reports.length)}
${tile("Ready (provisional)", count("ready"), count("ready") ? "ready" : "")}
${tile("Need review", count("needs_review"), count("needs_review") ? "needs_review" : "")}
${tile("Don't balance", count("unbalanced"), count("unbalanced") ? "unbalanced" : "")}
${tile("Facts to record", by("facts").length)}
${tile("Integration problems", by("integration").length)}
${tile("For the accountant", by("accounting").length)}
</div>
<p class="muted small">${signoffTypes.size} treatment(s) are awaiting the accountant's sign-off. They keep payouts <b>Provisional</b> but aren't listed here, because staff can't fix them.</p>`;

  const payoutLinks = (g: Group) => {
    const ready = unblocks(g);
    return `${g.reports.map((r) => `<a href="${payoutLink(r.channel, r.payoutId)}">${channelName(r.channel)} ${esc(r.payoutDate)}</a>`).join("<br>")}${
      ready.length ? `<div class="chip ready small" style="margin-top:4px">Fixing this makes ${ready.length} payout${ready.length === 1 ? "" : "s"} ready</div>` : ""
    }`;
  };

  const factRows = by("facts")
    .map((g) => {
      const i = g.issues[0]!;
      const first = g.reports[0]!;
      const what = g.issues.map((x) => esc(ISSUE_LABEL[x.code] ?? x.code)).join(", ");
      const detail = g.sku && SKU_FORM_CODES.has(i.code)
        ? `<b>${esc(g.title ?? g.sku)}</b> <code>${esc(g.sku)}</code><div class="muted small">${what}${g.cents ? ` · ${fmt(g.cents)}` : ""}</div>`
        : `<b>${what}</b>${i.code === "unknown_destination" ? `<div>Order ${esc(first.sales.find((l) => l.orderId === i.orderId)?.orderName ?? i.orderId)}</div>` : g.title ? `<div>${esc(g.title)}</div>` : ""}<div class="muted small">${esc(i.message)}</div>`;
      const fix = g.sku && SKU_FORM_CODES.has(i.code)
        ? factForm(g, d, back, skusInQueue)
        : fixFor(i, first.channel, g.title, back, i.consignorId ? consignorNames.get(i.consignorId) : undefined) ||
          (i.code === "unknown_sku" ? `<span class="muted small">Add a SKU to this listing in ${channelName(first.channel)}, then fetch again.</span>` : "");
      return `<tr><td>${detail}</td><td class="small">${payoutLinks(g)}</td><td>${fix}</td></tr>`;
    })
    .join("");

  const otherRows = (grp: IssueGroup) =>
    by(grp)
      .map((g) => {
        const i = g.issues[0]!;
        const first = g.reports[0]!;
        return `<tr><td><b>${esc(ISSUE_LABEL[i.code] ?? i.code)}</b>${g.sku ? ` <code>${esc(g.sku)}</code>` : ""}<div class="muted small">${g.issues.map((x) => esc(x.message)).join("<br>")}</div></td>
<td class="small">${payoutLinks(g)}</td><td><a class="small" href="${payoutLink(first.channel, first.payoutId)}">Open payout</a></td></tr>`;
      })
      .join("");

  const section = (title: string, intro: string, rows: string, empty: string, cols: string) =>
    `<h2>${title}</h2><p class="muted small">${intro}</p><div class="wrap"><table>${cols}${rows || `<tr><td colspan="3" class="muted">${empty}</td></tr>`}</table></div>`;

  const body = `<h1>Review queue</h1>
${message(msg)}
${channelToggle("/review", channel)}
${summary}
${canReset ? `<p>${clearButton(true)}</p>` : ""}
${section(
  "Facts to record",
  "Record what you know about each item once. Every open payout is rebuilt straight away, and the result shows at the top of this page.",
  factRows,
  `No missing facts${channel ? ` for ${channelName(channel)}` : ""}.`,
  "<tr><th>Item</th><th>Payouts</th><th>Record</th></tr>",
)}
${section("Integration problems", "The platform data didn't line up (missing order details, unknown transaction types, amounts that don't match). These need a look, not a fact.", otherRows("integration"), "None.", "<tr><th>Problem</th><th>Payouts</th><th></th></tr>")}
${section("For the accountant", "Treatments that aren't decided yet, disputes, and items no scenario covers.", otherRows("accounting"), "None.", "<tr><th>Problem</th><th>Payouts</th><th></th></tr>")}`;
  return page("Review queue", body);
}

export interface ConsignorOption {
  id: number;
  name: string;
  country: string | null;
  australian_gst_registered: number | null;
  agreement_type: string | null;
  commission_type?: string | null;
  commission_value?: number | null;
}

export function renderStockForm(
  prefill: { sku?: string; title?: string },
  consignors: ConsignorOption[],
  msg?: string,
): Response {
  const gstLabel = (c: ConsignorOption) =>
    `${c.country ? ` · ${c.country}` : ""}${
      c.australian_gst_registered === 1 ? " · AU GST-registered" : c.australian_gst_registered === null ? " · AU GST unknown" : ""
    }`;
  const body = `<h1>Stock record</h1>
<p class="muted">Record the facts once per item. The GST scenario is worked out from them and follows the item to whichever channel it sells on.</p>
${message(msg)}
<form class="grid" method="post" action="/stock">
<label>SKU<input name="sku" required value="${esc(prefill.sku)}"></label>
<label>Item<input name="title" value="${esc(prefill.title)}"></label>
<label>Ownership<select name="ownership"><option value="owned">LOFI-owned</option><option value="consignment">Consignment</option></select></label>
<label>Acquired from (LOFI-owned)<select name="acquired_from"><option value="">Not recorded</option><option value="registered_supplier">GST-registered supplier</option><option value="private_seller">Private / non-GST seller</option><option value="trade_in">Trade-in</option><option value="other">Other</option></select></label>
<label>Condition when bought<select name="item_condition"><option value="">Not recorded</option><option value="new">New</option><option value="secondhand">Second-hand</option></select></label>
<label>Purchase price (AUD)<input name="purchase_aud" inputmode="decimal"></label>
<label>Purchase date<input name="purchase_date" type="date"></label>
<label>Seller name (Division 66)<input name="seller_name"></label>
<label>Seller address (Division 66)<input name="seller_address"></label>
<label>Description and quantity (Division 66)<input name="seller_description"></label>
<label>Consignor<select name="consignor_id"><option value="">—</option>${consignors
    .map((c) => `<option value="${c.id}">${esc(c.name)}${gstLabel(c)}</option>`)
    .join("")}</select></label>
<label>Commission override<select name="commission_type"><option value="">Use consignor's default</option><option value="percent">Percent</option><option value="fixed">Fixed AUD</option></select></label>
<label>Commission value<input name="commission_value" inputmode="decimal"></label>
<label>Notes<input name="notes"></label>
<div style="align-self:end"><button>Save</button></div>
</form>
<h2 id="new-consignor">New consignor</h2>
<form class="grid" method="post" action="/consignors">
<label>Name<input name="name" required></label>
<label>Contact<input name="contact"></label>
<label>Country (two letters)<input name="country" maxlength="2" placeholder="US, JP, AU…"></label>
<label>Registered for Australian GST<select name="australian_gst"><option value="auto">Automatic: No if overseas, otherwise ask</option><option value="no">No</option><option value="yes">Yes</option><option value="unknown">Not sure yet</option></select></label>
<label>ABN<input name="abn"></label>
<label>Default commission %<input name="commission_value" inputmode="decimal"></label>
<label>Agreement (needed only if registered for Australian GST)<select name="agreement_type"><option value="">Not recorded</option><option value="agency">Ordinary agency</option><option value="153B">Subdivision 153-B</option></select></label>
<div style="align-self:end"><button>Add consignor</button></div>
</form>`;
  return page("Stock record", body);
}
