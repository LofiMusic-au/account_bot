// Server-rendered dashboard. Plain HTML, no build step.

import { fmt } from "./money";
import { FEE_CATEGORIES, REPORT_VERSION, type PayoutReport } from "./reconcile";
import type { ReportSummary, SourceInfo } from "./db";
import type { FeeCategory, Issue, LineClassification, SourceRef } from "./types";

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
  unknown_consignor_gst_status: "Consignor GST status unknown",
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
</style></head><body>
<header><b>LOFI payout reconciliation</b><a href="/">Payouts</a><a href="/review">Review queue</a><a href="/stock/new">Add stock record</a>
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

export function renderIndex(rows: ReportSummary[], msg?: string): Response {
  const body = `
<h1>Payouts</h1>
<p class="muted">Each payout is rebuilt into its sales, fees, refunds and adjustments, GST is worked out per LOFI's draft scenarios, and the total is checked against the actual payout to the cent.
<b>Provisional</b> means at least one treatment used isn't signed off by the accountant yet.</p>
${message(msg)}
<form method="post" action="/run" style="margin:12px 0"><button>Fetch new payouts now</button></form>
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
${rows.length === 0 ? `<tr><td colspan="9" class="muted">No payouts yet. Press "Fetch new payouts now".</td></tr>` : ""}
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
        ? `<div class="small muted">Is ${esc(consignorName ?? `consignor #${issue.consignorId}`)} registered for GST?</div>
<form class="inline" method="post" action="/facts/consignor">${hidden("id", issue.consignorId)}${hidden("return", back)}
<button class="alt" name="gst" value="registered">Registered</button><button class="alt" name="gst" value="not_registered">Not registered</button></form>`
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
  const scenarioCounts = t.byScenario.filter((s) => s.code !== "SHIPPING");
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
    .map((s) => `${s.count} ${esc(s.code)}`)
    .join(" · ")}${r.blockingCount ? ` · <span class="review">${r.blockingCount} to fix</span>` : ""}</p>
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

<h2>By scenario</h2>
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

export interface ReviewItem {
  report: PayoutReport;
  issue: Issue;
}

export function renderReview(items: ReviewItem[], consignors: Map<number, string>, msg?: string): Response {
  // One row per distinct problem: the same unknown SKU in three payouts is one fix.
  const groups = new Map<string, { issue: Issue; title: string | null; reports: PayoutReport[] }>();
  for (const { report: r, issue: i } of items) {
    const key = i.sku ? `${i.code}|sku|${i.sku.toUpperCase()}` : i.consignorId ? `${i.code}|c|${i.consignorId}` : `${i.code}|${r.channel}|${r.payoutId}|${i.orderId ?? ""}|${i.transactionId ?? ""}|${i.message}`;
    const g = groups.get(key) ?? { issue: i, title: null, reports: [] };
    g.title ??= [...r.sales, ...r.refunds].find((l) => l.lineId === i.lineId)?.title ?? null;
    if (!g.reports.includes(r)) g.reports.push(r);
    groups.set(key, g);
  }
  const rows = [...groups.values()];
  const body = `<h1>Review queue</h1>
<p class="muted">Missing facts and numbers that don't add up, across recent payouts. Record the fact once; every open payout is rebuilt straight away.
Treatments awaiting the accountant aren't listed here; they show as <b>Provisional</b> on each payout.</p>
${message(msg)}
<div class="wrap"><table><tr><th>Problem</th><th>Detail</th><th>Payouts</th><th>Fix</th></tr>
${rows
  .map(({ issue: i, title, reports }) => {
    const first = reports[0]!;
    return `<tr><td><b>${esc(ISSUE_LABEL[i.code] ?? i.code)}</b>${i.sku ? `<div><code>${esc(i.sku)}</code></div>` : ""}</td>
<td>${title ? `${esc(title)}<br>` : ""}<span class="muted small">${esc(i.message)}</span></td>
<td class="small">${reports.map((r) => `<a href="${payoutLink(r.channel, r.payoutId)}">${channelName(r.channel)} ${esc(r.payoutDate)}</a>`).join("<br>")}</td>
<td>${fixFor(i, first.channel, title, "/review", i.consignorId ? consignors.get(i.consignorId) : undefined) || `<a class="small" href="${payoutLink(first.channel, first.payoutId)}">Open payout</a>`}</td></tr>`;
  })
  .join("")}
${rows.length === 0 ? `<tr><td colspan="4" class="muted">Nothing to review.</td></tr>` : ""}
</table></div>`;
  return page("Review queue", body);
}

export function renderStockForm(
  prefill: { sku?: string; title?: string },
  consignors: { id: number; name: string; gst_registered: number; gst_status: string | null }[],
  msg?: string,
): Response {
  const gstLabel = (c: { gst_status: string | null }) =>
    c.gst_status === "registered" ? " (GST-registered)" : c.gst_status === null ? " (GST status unknown)" : "";
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
<h2>New consignor</h2>
<form class="grid" method="post" action="/consignors">
<label>Name<input name="name" required></label>
<label>Contact<input name="contact"></label>
<label>GST-registered<select name="gst_registered"><option value="">Not sure yet</option><option value="0">No</option><option value="1">Yes</option></select></label>
<label>ABN<input name="abn"></label>
<label>Default commission %<input name="commission_value" inputmode="decimal"></label>
<label>Agreement<select name="agreement_type"><option value="agency">Agency</option><option value="153B">Subdivision 153-B</option></select></label>
<div style="align-self:end"><button>Add consignor</button></div>
</form>`;
  return page("Stock record", body);
}
