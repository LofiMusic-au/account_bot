// Server-rendered dashboard. Plain HTML, no build step.

import { fmt } from "./money";
import type { PayoutReport } from "./reconcile";
import type { ReportSummary } from "./db";
import type { LineClassification } from "./types";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STATUS_LABEL: Record<string, string> = {
  ready: "Balanced",
  needs_review: "Needs review",
  unbalanced: "Doesn't balance",
};

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--card:#fff;--good:#1f7a4d;--warn:#a15c00;--bad:#b3261e;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#a3a29b;--line:#2f2e2b;--card:#1f1f1d;--good:#5cc98f;--warn:#f0a94b;--bad:#f2766d;--accent:#8aa8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header b{font-size:15px}header a{color:var(--muted);text-decoration:none}header a:hover{color:var(--fg)}
main{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0 4px}h2{font-size:15px;margin:28px 0 8px}
.muted{color:var(--muted)}.note{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:12px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:12px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.tile .v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:0}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid currentColor;white-space:nowrap}
.ready,.approved{color:var(--good)}.needs_review,.draft{color:var(--warn)}.unbalanced,.review{color:var(--bad)}
.flags{margin:4px 0 0;padding-left:16px;color:var(--muted);font-size:12px}
a{color:var(--accent)}button,input,select{font:inherit}
button{background:var(--fg);color:var(--bg);border:0;border-radius:6px;padding:6px 12px;cursor:pointer}
form.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}
input,select{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
</style></head><body>
<header><b>LOFI payout reconciliation</b><a href="/">Payouts</a><a href="/review">Review queue</a><a href="/stock/new">Add stock record</a>
<span class="muted" style="margin-left:auto">Report-only · nothing is posted to QuickBooks</span></header>
<main>${body}</main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const chip = (cls: string, label: string) => `<span class="chip ${esc(cls)}">${esc(label)}</span>`;
const channelName = (c: string) => (c === "ebay" ? "eBay" : c === "shopify" ? "Shopify" : c);

export function renderIndex(rows: ReportSummary[], message?: string): Response {
  const body = `
<h1>Payouts</h1>
<p class="muted">Each payout is rebuilt into its sales, fees and refunds, GST is worked out per LOFI's scenarios, and the total is checked against the bank deposit.</p>
${message ? `<div class="note">${esc(message)}</div>` : ""}
<form method="post" action="/run" style="margin:12px 0"><button>Fetch new payouts now</button></form>
<div class="wrap"><table>
<tr><th>Date</th><th>Channel</th><th>Payout</th><th class="n">Deposit</th><th class="n">Sales</th><th class="n">GST</th><th class="n">Difference</th><th>Status</th></tr>
${rows
  .map(
    (r) => `<tr><td>${esc(r.payout_date)}</td><td>${channelName(r.channel)}</td>
<td><a href="/payout/${esc(r.channel)}/${encodeURIComponent(r.payout_id)}">${esc(r.payout_id)}</a></td>
<td class="n">${fmt(r.net_cents)}</td><td class="n">${r.sale_count}</td><td class="n">${fmt(r.gst_cents)}</td>
<td class="n">${r.difference_cents === 0 ? "$0.00" : `<span class="unbalanced">${fmt(r.difference_cents)}</span>`}</td>
<td>${chip(r.status, STATUS_LABEL[r.status] ?? r.status)}${r.review_count ? ` <span class="muted">${r.review_count} to review</span>` : ""}</td></tr>`,
  )
  .join("")}
${rows.length === 0 ? `<tr><td colspan="8" class="muted">No payouts yet. Press "Fetch new payouts now".</td></tr>` : ""}
</table></div>`;
  return page("Payouts", body);
}

function linesTable(lines: LineClassification[]): string {
  if (lines.length === 0) return `<p class="muted">None.</p>`;
  return `<div class="wrap"><table>
<tr><th>Order</th><th>SKU</th><th>Item</th><th>Scenario</th><th>Status</th><th class="n">Amount</th><th class="n">GST</th><th class="n">Div 66 credit</th><th>Postings</th></tr>
${lines
  .map(
    (l) => `<tr><td>${esc(l.orderName)}</td><td>${l.sku ? esc(l.sku) : `<span class="muted">—</span>`}</td>
<td>${esc(l.title)}<div class="muted" style="font-size:12px">${esc(l.reason)}</div>
${l.flags.length ? `<ul class="flags">${l.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
${l.approval === "review" && l.sku ? `<a href="/stock/new?sku=${encodeURIComponent(l.sku)}&title=${encodeURIComponent(l.title)}" style="font-size:12px">Add stock record</a>` : ""}</td>
<td>${esc(l.scenario)}</td><td>${chip(l.approval, l.approval)}</td>
<td class="n">${fmt(l.grossCents)}</td><td class="n">${fmt(l.gstCents)}</td><td class="n">${l.notionalItcCents ? fmt(l.notionalItcCents) : ""}</td>
<td style="font-size:12px">${l.postings.map((p) => `${esc(p.account)} · ${esc(p.taxCode)} · ${fmt(p.grossCents)}`).join("<br>")}</td></tr>`,
  )
  .join("")}
</table></div>`;
}

export function renderReport(r: PayoutReport): Response {
  const t = r.totals;
  const body = `
<p class="muted"><a href="/">← Payouts</a></p>
<h1>${channelName(r.channel)} payout ${esc(r.payoutId)}</h1>
<p>${esc(r.payoutDate)} · ${chip(r.status, STATUS_LABEL[r.status] ?? r.status)} <span class="muted">· generated ${esc(r.generatedAt.slice(0, 16).replace("T", " "))} UTC</span></p>
<form method="post" action="/payout/${esc(r.channel)}/${encodeURIComponent(r.payoutId)}/rerun"><button>Re-run with latest stock records</button></form>
<div class="tiles">
<div class="tile"><div class="muted">Bank deposit</div><div class="v">${fmt(r.netCents)}</div></div>
<div class="tile"><div class="muted">Rebuilt from transactions</div><div class="v">${fmt(r.expectedCents)}</div></div>
<div class="tile"><div class="muted">Difference</div><div class="v ${r.differenceCents ? "unbalanced" : "ready"}">${fmt(r.differenceCents)}</div></div>
<div class="tile"><div class="muted">GST on sales</div><div class="v">${fmt(t.gstCents)}</div></div>
<div class="tile"><div class="muted">Division 66 credits</div><div class="v">${fmt(t.notionalItcCents)}</div></div>
</div>
<div class="wrap"><table>
<tr><th>How the deposit is made up</th><th class="n">Amount</th></tr>
<tr><td>Sales collected (${r.saleCount} orders)</td><td class="n">${fmt(t.salesGrossCents)}</td></tr>
<tr><td>Refunds</td><td class="n">${fmt(-t.refundsCents)}</td></tr>
<tr><td>Fees</td><td class="n">${fmt(-t.feesCents)}</td></tr>
<tr><td>Other adjustments</td><td class="n">${fmt(t.adjustmentsCents)}</td></tr>
<tr><td><b>Expected deposit</b></td><td class="n"><b>${fmt(r.expectedCents)}</b></td></tr>
</table></div>
${r.warnings.length ? `<h2>Warnings</h2><div class="note"><ul style="margin:0;padding-left:18px">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
<h2>By scenario</h2>
<div class="wrap"><table><tr><th>Scenario</th><th class="n">Lines</th><th class="n">Amount</th><th class="n">GST</th></tr>
${t.byScenario.map((s) => `<tr><td><b>${esc(s.code)}</b> ${esc(s.name)}</td><td class="n">${s.count}</td><td class="n">${fmt(s.grossCents)}</td><td class="n">${fmt(s.gstCents)}</td></tr>`).join("")}
</table></div>
<h2>Sales</h2>${linesTable(r.sales)}
<h2>Refunds</h2>${linesTable(r.refunds)}
<h2>Fees</h2>
${r.fees.length ? `<div class="wrap"><table><tr><th>Type</th><th>Description</th><th>Tax code</th><th class="n">Amount</th></tr>
${r.fees.map((f) => `<tr><td>${esc(f.type)}</td><td>${esc(f.description)}</td><td>${esc(f.taxCode)}</td><td class="n">${fmt(f.cents)}</td></tr>`).join("")}</table></div>` : `<p class="muted">None.</p>`}
<h2>Other adjustments</h2>
${r.adjustments.length ? `<div class="wrap"><table><tr><th>Type</th><th>Description</th><th class="n">Amount</th></tr>
${r.adjustments.map((a) => `<tr><td>${esc(a.type)}</td><td>${esc(a.description)}</td><td class="n">${fmt(a.cents)}</td></tr>`).join("")}</table></div>` : `<p class="muted">None.</p>`}
`;
  return page(`Payout ${r.payoutId}`, body);
}

export function renderReview(items: { report: PayoutReport; line: LineClassification }[]): Response {
  const body = `<h1>Review queue</h1>
<p class="muted">Sale lines the rules couldn't classify. Add a stock record (or a SKU prefix rule), then re-run the payout.</p>
<div class="wrap"><table><tr><th>Payout</th><th>Order</th><th>SKU</th><th>Item</th><th>Why</th><th class="n">Amount</th><th></th></tr>
${items
  .map(
    ({ report: r, line: l }) => `<tr><td><a href="/payout/${esc(r.channel)}/${encodeURIComponent(r.payoutId)}">${channelName(r.channel)} ${esc(r.payoutDate)}</a></td>
<td>${esc(l.orderName)}</td><td>${esc(l.sku ?? "—")}</td><td>${esc(l.title)}</td><td>${esc(l.reason)}</td><td class="n">${fmt(l.grossCents)}</td>
<td>${l.sku ? `<a href="/stock/new?sku=${encodeURIComponent(l.sku)}&title=${encodeURIComponent(l.title)}">Classify</a>` : ""}</td></tr>`,
  )
  .join("")}
${items.length === 0 ? `<tr><td colspan="7" class="muted">Nothing to review.</td></tr>` : ""}
</table></div>`;
  return page("Review queue", body);
}

export function renderStockForm(
  prefill: { sku?: string; title?: string },
  consignors: { id: number; name: string; gst_registered: number }[],
  message?: string,
): Response {
  const body = `<h1>Stock record</h1>
<p class="muted">Recorded once per item. The GST scenario then follows the item to whichever channel it sells on.</p>
${message ? `<div class="note">${esc(message)}</div>` : ""}
<form class="grid" method="post" action="/stock">
<label>SKU<input name="sku" required value="${esc(prefill.sku)}"></label>
<label>Item<input name="title" value="${esc(prefill.title)}"></label>
<label>Ownership<select name="ownership"><option value="owned">LOFI-owned</option><option value="consignment">Consignment</option></select></label>
<label>Bought from (owned stock)<select name="acquired_from"><option value="">—</option><option value="registered_supplier">GST-registered supplier</option><option value="private_seller">Private seller</option><option value="trade_in">Trade-in</option></select></label>
<label>Purchase price (AUD)<input name="purchase_aud" inputmode="decimal"></label>
<label>Purchase date<input name="purchase_date" type="date"></label>
<label>Seller name (Division 66)<input name="seller_name"></label>
<label>Seller address (Division 66)<input name="seller_address"></label>
<label>Description and quantity (Division 66)<input name="seller_description"></label>
<label>Consignor<select name="consignor_id"><option value="">—</option>${consignors
    .map((c) => `<option value="${c.id}">${esc(c.name)}${c.gst_registered ? " (GST-registered)" : ""}</option>`)
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
<label>GST-registered<select name="gst_registered"><option value="0">No</option><option value="1">Yes</option></select></label>
<label>ABN<input name="abn"></label>
<label>Default commission %<input name="commission_value" inputmode="decimal"></label>
<label>Agreement<select name="agreement_type"><option value="agency">Agency</option><option value="153B">Subdivision 153-B</option></select></label>
<div style="align-self:end"><button>Add consignor</button></div>
</form>`;
  return page("Stock record", body);
}
