// QuickBooks SANDBOX integration test. Sandbox only (refuses otherwise).
//
//   npm run qbo:sandbox -- discover
//   npm run qbo:sandbox -- map [--create] [--tax "GST (10% Sales)=<id>" ...]
//   npm run qbo:sandbox -- prove <channel> <payoutId>
//
// `map` and `prove` use the running local Worker (`npm run dev`, restarted
// after qbo:connect) so the real posting code path is what gets tested.
// Raw requests/responses are saved to .live/qbo-sandbox/ (git-ignored).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localSql, readVars, requireSandbox, root, SandboxClient } from "./qbo-lib";
import type { JournalPreview } from "../src/posting/journal";

const WORKER = "http://localhost:8787";
const outDir = join(root, ".live", "qbo-sandbox");
mkdirSync(outDir, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(join(outDir, name), typeof data === "string" ? data : JSON.stringify(data, null, 1));
const [cmd, ...args] = process.argv.slice(2);
const v = requireSandbox(readVars());
const qbo = new SandboxClient(v);

type Acct = { Id: string; Name: string; AccountType: string; AccountSubType?: string; Active?: boolean };
type TaxRate = { Id: string; Name: string; RateValue?: number; Active?: boolean };
type TaxCode = {
  Id: string;
  Name: string;
  Description?: string;
  Active?: boolean;
  SalesTaxRateList?: { TaxRateDetail?: { TaxRateRef: { value: string; name?: string } }[] };
  PurchaseTaxRateList?: { TaxRateDetail?: { TaxRateRef: { value: string; name?: string } }[] };
};

async function discover() {
  const info = await qbo.call<{ CompanyInfo: { CompanyName: string; Country: string; LegalName?: string } }>("GET", `/companyinfo/${v.QBO_REALM_ID}`);
  const prefs = await qbo.call<{ Preferences: unknown }>("GET", "/preferences");
  const accounts = await qbo.query<Acct>("select * from Account maxresults 1000", "Account");
  const codes = await qbo.query<TaxCode>("select * from TaxCode maxresults 1000", "TaxCode");
  const rates = await qbo.query<TaxRate>("select * from TaxRate maxresults 1000", "TaxRate");
  save("discovery.json", { companyInfo: info.json, preferences: prefs.json, accounts, taxCodes: codes, taxRates: rates });
  return { info: info.json.CompanyInfo, prefs: prefs.json, accounts, codes, rates };
}

function rateOf(rates: TaxRate[], list?: TaxCode["SalesTaxRateList"]) {
  return (list?.TaxRateDetail ?? []).map((d) => rates.find((r) => r.Id === d.TaxRateRef.value)?.RateValue ?? null);
}

async function printDiscovery() {
  const d = await discover();
  console.log(`Company: ${d.info.CompanyName} | Country: ${d.info.Country}`);
  const p = d.prefs as { Preferences?: { CurrencyPrefs?: unknown; TaxPrefs?: unknown } };
  console.log(`Currency prefs: ${JSON.stringify(p.Preferences?.CurrencyPrefs)}`);
  console.log(`Tax prefs: ${JSON.stringify(p.Preferences?.TaxPrefs)}`);
  console.log(`\nTax codes (${d.codes.length}):`);
  for (const c of d.codes) console.log(`  ${c.Id}\t${c.Name}\tsales ${JSON.stringify(rateOf(d.rates, c.SalesTaxRateList))}\tpurchase ${JSON.stringify(rateOf(d.rates, c.PurchaseTaxRateList))}\t${c.Description ?? ""}${c.Active === false ? " (inactive)" : ""}`);
  console.log(`\nAccounts (${d.accounts.length}):`);
  for (const a of d.accounts) console.log(`  ${a.Id}\t${a.Name}\t${a.AccountType}/${a.AccountSubType ?? ""}`);
  console.log(`\nSaved raw responses to .live/qbo-sandbox/discovery.json`);
}

/** Sandbox accounts the payout needs: [logical key, name, type to create]. */
const NEEDED: [string, string, string][] = [
  ["SALES_DOMESTIC_GST", "Sales", "Income"],
  ["SALES_OVERSEAS_NO_GST", "Overseas Sales", "Income"],
  ["CONSIGNMENT_SALES_NO_GST", "Commission Sales", "Income"],
  ["EBAY_FEES", "eBay Fees", "Expense"],
  ["SHOPIFY_FEES", "Shopify Fees", "Expense"],
  ["MARKETPLACE_ADJUSTMENTS", "Marketplace Adjustments", "Other Income"],
  ["EBAY_CLEARING", "eBay Clearing", "Other Current Asset"],
  ["SHOPIFY_PAYMENTS_CLEARING", "Shopify Payments Clearing", "Other Current Asset"],
  ["BANK", "LOFI Payouts Bank (sandbox)", "Bank"],
];

async function map() {
  const create = args.includes("--create");
  const overrides = new Map<string, string>();
  for (let i = 0; i < args.length; i++) if (args[i] === "--tax") {
    const [k, id] = args[i + 1]!.split("=");
    overrides.set(k!, id!);
  }
  const d = await discover();
  if (d.info.Country !== "AU") console.log(`WARNING: sandbox company country is ${d.info.Country}, not AU; Australian GST can't be validated faithfully.`);
  const accounts: Record<string, string> = {};
  for (const [key, name, type] of NEEDED) {
    let a = d.accounts.find((x) => x.Name.toLowerCase() === name.toLowerCase() && x.Active !== false);
    if (!a && create) {
      const r = await qbo.call<{ Account?: Acct }>("POST", "/account", { Name: name, AccountType: type });
      save(`create-account-${key}.json`, r.json);
      if (r.status !== 200 || !r.json.Account) throw new Error(`Creating sandbox account ${name} failed (${r.status}): ${r.raw.slice(0, 400)}`);
      a = r.json.Account;
      console.log(`  created ${key} -> "${a.Name}" (${a.Id}, ${a.AccountType})`);
    }
    if (a) {
      accounts[key] = a.Id;
      console.log(`  ${key} -> "${a.Name}" (${a.Id}, ${a.AccountType})`);
    } else console.log(`  ${key} -> NOT FOUND (re-run with --create to create "${name}")`);
  }
  // Tax codes, matched on their actual rates in this company; ambiguity needs --tax.
  const active = d.codes.filter((c) => c.Active !== false);
  const pick = (label: string, side: "sales" | "purchase", rate: number, nameTest: RegExp) => {
    if (overrides.has(label)) return overrides.get(label)!;
    const hits = active.filter((c) => rateOf(d.rates, side === "sales" ? c.SalesTaxRateList : c.PurchaseTaxRateList).includes(rate) && nameTest.test(`${c.Name} ${c.Description ?? ""}`));
    if (hits.length === 1) return hits[0]!.Id;
    console.log(`  ${label}: ${hits.length ? `ambiguous (${hits.map((h) => `${h.Id} ${h.Name}`).join(", ")})` : "no match"}. Pass --tax "${label}=<id>".`);
    return null;
  };
  const taxCodes: Record<string, string> = {};
  const want: [string, "sales" | "purchase", number, RegExp][] = [
    ["GST (10% Sales)", "sales", 10, /^GST\b(?!.*(capital|import|export|input|free))/i],
    ["GST free (0% Sales)", "sales", 0, /free|FRE/i],
    ["GST on purchases (10%)", "purchase", 10, /^GST\b(?!.*(capital|import|export|input|free))/i],
    ["GST free purchases (0%)", "purchase", 0, /free|FRE/i],
  ];
  for (const [label, side, rate, re] of want) {
    const id = pick(label, side, rate, re);
    if (id) {
      taxCodes[label] = id;
      console.log(`  ${label} -> tax code ${id} (${d.codes.find((c) => c.Id === id)?.Name})`);
    }
  }
  const res = await fetch(`${WORKER}/api/qbo/map`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts, taxCodes }) });
  console.log(`Saved to the local Worker: ${res.status} ${await res.text()}`);
  save("mapping.json", { accounts, taxCodes });
}

async function worker(path: string, method = "GET") {
  const res = await fetch(`${WORKER}${path}`, { method, redirect: "manual" });
  const loc = res.headers.get("Location");
  return { status: res.status, msg: loc ? new URL(loc, WORKER).searchParams.get("msg") : null, body: method === "GET" ? await res.text() : "" };
}

const posting = (ch: string, id: string) =>
  localSql<Record<string, string | null>>(`SELECT * FROM qbo_postings WHERE channel = '${ch}' AND payout_id = '${id.replace(/'/g, "")}'`)[0];

async function prove(channel: string, payoutId: string) {
  const log: string[] = [];
  const say = (s: string) => {
    console.log(s);
    log.push(s);
  };
  const qboPage = await worker("/qbo");
  if (!/Mode: sandbox/.test(qboPage.body)) throw new Error("The local Worker isn't in sandbox mode. Run `npm run qbo:connect`, then restart `npm run dev`.");
  const map = { accounts: new Map(localSql<{ account_key: string; qbo_account_id: string }>("SELECT * FROM qbo_account_map").map((r) => [r.account_key, r.qbo_account_id])), taxCodes: new Map(localSql<{ tax_code_name: string; qbo_tax_code_id: string }>("SELECT * FROM qbo_tax_code_map").map((r) => [r.tax_code_name, r.qbo_tax_code_id])) };

  let row = posting(channel, payoutId);
  if (!row) throw new Error(`No posting row for ${channel} ${payoutId}`);
  const preview = JSON.parse(row.preview_json!) as JournalPreview;
  save(`preview-${payoutId}.json`, preview);
  say(`# Sandbox proof: ${channel} ${payoutId}\n\nStatus before: ${row.status}. Fingerprint ${row.preview_fingerprint}.`);
  if (row.status === "ready_for_review") say(`Approve: ${(await worker(`/payout/${channel}/${payoutId}/approve`, "POST")).msg}`);

  say(`Post (1st): ${(await worker(`/payout/${channel}/${payoutId}/post`, "POST")).msg}`);
  row = posting(channel, payoutId)!;
  if (row.status !== "posted") {
    say(`\nSTOPPED: status ${row.status}. QuickBooks said: ${row.last_error}`);
    save(`report-${payoutId}.md`, log.join("\n"));
    return;
  }
  const journalId = row.journal_id!;
  const transferId = row.transfer_id!;
  say(`Journal ${journalId} (${row.journal_doc_number}), transfer ${transferId}.`);

  // Re-fetch and compare the journal.
  const j = await qbo.call<{ JournalEntry: { TxnDate: string; DocNumber: string; PrivateNote?: string; TotalAmt?: number; GlobalTaxCalculation?: string; TxnTaxDetail?: unknown; Line: { Amount: number; Description?: string; JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string; name?: string }; TaxCodeRef?: { value: string }; TaxApplicableOn?: string; TaxAmount?: number } }[] } }>("GET", `/journalentry/${journalId}`);
  save(`journal-${journalId}.json`, j.json);
  const je = j.json.JournalEntry;
  say(`\n## Journal re-fetched\nTxnDate ${je.TxnDate} (expected ${preview.txnDate}) · DocNumber ${je.DocNumber} (expected ${preview.docNumber}) · GlobalTaxCalculation ${je.GlobalTaxCalculation ?? "—"} · TotalAmt ${je.TotalAmt}`);
  say(`TxnTaxDetail: ${JSON.stringify(je.TxnTaxDetail ?? null)}`);
  say("\n| Expected account | Expected | QuickBooks line | Tax code sent → back | GST sent → back | Match |\n|---|---|---|---|---|---|");
  for (const l of preview.lines) {
    const acct = map.accounts.get(l.accountKey);
    const hit = je.Line.find((x) => x.JournalEntryLineDetail?.AccountRef.value === acct && x.JournalEntryLineDetail.PostingType === l.postingType);
    const amt = hit ? Math.round(hit.Amount * 100) : null;
    const tax = l.taxCode ? map.taxCodes.get(l.taxCode) ?? null : null;
    const ok = !!hit && (amt === l.amountCents || amt === l.amountCents - l.gstCents) && (hit.JournalEntryLineDetail.TaxCodeRef?.value ?? null) === tax;
    say(`| ${l.accountName} (${l.accountKey}) | ${l.postingType} ${(l.amountCents / 100).toFixed(2)} | ${hit ? `${hit.JournalEntryLineDetail.PostingType} ${hit.Amount} → ${hit.JournalEntryLineDetail.AccountRef.name ?? acct}` : "MISSING"} | ${tax ?? "—"} → ${hit?.JournalEntryLineDetail.TaxCodeRef?.value ?? "—"} | ${(l.gstCents / 100).toFixed(2)} → ${hit?.JournalEntryLineDetail.TaxAmount ?? "—"} | ${ok ? "yes" : "CHECK"} |`);
  }
  if (je.Line.length !== preview.lines.length) say(`Note: QuickBooks returned ${je.Line.length} lines for ${preview.lines.length} sent (it may add tax lines).`);

  const t = await qbo.call<{ Transfer: { Amount: number; TxnDate: string; FromAccountRef: { value: string; name?: string }; ToAccountRef: { value: string; name?: string }; PrivateNote?: string } }>("GET", `/transfer/${transferId}`);
  save(`transfer-${transferId}.json`, t.json);
  const tr = t.json.Transfer;
  say(`\n## Transfer re-fetched\n${tr.Amount} on ${tr.TxnDate} from ${tr.FromAccountRef.name ?? tr.FromAccountRef.value} to ${tr.ToAccountRef.name ?? tr.ToAccountRef.value}; note "${tr.PrivateNote}". Expected ${(preview.transfer.amountCents / 100).toFixed(2)} on ${preview.transfer.txnDate}.`);

  const countJournals = async () => (await qbo.query(`select Id from JournalEntry where DocNumber = '${preview.docNumber}'`, "JournalEntry")).length;
  const countTransfers = async () =>
    (await qbo.query<{ PrivateNote?: string }>(`select * from Transfer where TxnDate = '${preview.transfer.txnDate}'`, "Transfer")).filter((x) => (x.PrivateNote ?? "").includes(preview.transfer.reference)).length;

  say(`\n## Idempotency`);
  say(`Post (2nd, already posted): ${(await worker(`/payout/${channel}/${payoutId}/post`, "POST")).msg}`);
  say(`Journals with DocNumber ${preview.docNumber}: ${await countJournals()} · transfers with the reference: ${await countTransfers()}`);

  localSql(`UPDATE qbo_postings SET status = 'journal_posted', transfer_id = NULL WHERE channel = '${channel}' AND payout_id = '${payoutId}'`);
  say(`Recovery A (our record lost the transfer ID): ${(await worker(`/payout/${channel}/${payoutId}/post`, "POST")).msg}`);
  say(`  transfer ID now ${posting(channel, payoutId)!.transfer_id} (was ${transferId}); transfers with the reference: ${await countTransfers()}`);

  localSql(`UPDATE qbo_postings SET status = 'approved', journal_id = NULL, transfer_id = NULL, posted_fingerprint = NULL, posted_preview_json = NULL WHERE channel = '${channel}' AND payout_id = '${payoutId}'`);
  say(`Recovery B (our record lost both IDs, as after a lost response): ${(await worker(`/payout/${channel}/${payoutId}/post`, "POST")).msg}`);
  const after = posting(channel, payoutId)!;
  say(`  journal ${after.journal_id} (was ${journalId}), transfer ${after.transfer_id} (was ${transferId}); journals ${await countJournals()}, transfers ${await countTransfers()}`);

  say(`\n## GST reporting`);
  const rep = await qbo.call("GET", `/reports/TaxSummary?start_date=${preview.txnDate}&end_date=${preview.txnDate}`);
  save(`report-TaxSummary-${preview.txnDate}.json`, rep.json);
  say(`TaxSummary report: HTTP ${rep.status} (raw saved). ${rep.status === 200 ? "" : rep.raw.slice(0, 300)}`);
  const events = localSql<{ at: string; event: string; detail_json: string | null }>(`SELECT at, event, detail_json FROM qbo_posting_events WHERE channel = '${channel}' AND payout_id = '${payoutId}' ORDER BY id`);
  say(`\n## Posting events\n${events.map((e) => `- ${e.at} ${e.event} ${e.detail_json ?? ""}`).join("\n")}`);
  save(`report-${payoutId}.md`, log.join("\n"));
  console.log(`\nReport saved to .live/qbo-sandbox/report-${payoutId}.md`);
}

if (cmd === "discover") await printDiscovery();
else if (cmd === "map") await map();
else if (cmd === "prove" && args[0] && args[1]) await prove(args[0], args[1]);
else console.log("Usage: qbo-sandbox.ts discover | map [--create] [--tax \"<name>=<id>\"] | prove <channel> <payoutId>");
