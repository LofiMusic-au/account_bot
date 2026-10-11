// One QuickBooks journal per payout, built from the reconciled report:
//
//   Cr Sales / Overseas Sales / Commission Sales   (sales + shipping, by category)
//   Dr the same accounts                           (refunds, reversing their original category)
//   Dr fee accounts                                (fees; credits reduce them)
//   Cr/Dr Marketplace Adjustments                  (recognised adjustments)
//   Dr channel clearing                            (the exact net payout)
//
// then one transfer: clearing -> bank for the same net amount, which is what
// the bank feed matches. Amounts are GST-inclusive; the tax code on each line
// says how QuickBooks treats the GST. Dated on the payout date.

import { gstInclusive } from "../money";
import type { PayoutReport } from "../reconcile";
import { ACCOUNT_DEFS, CLEARING_FOR, FEE_ACCOUNT, FEE_TAX_CODE, SALES_ACCOUNT, taxRateBp, type AccountKey, type TaxCodeName } from "./accounts";

export interface JournalLine {
  accountKey: AccountKey;
  accountName: string;
  postingType: "Debit" | "Credit";
  /** Positive, GST-inclusive cents. */
  amountCents: number;
  taxCode: TaxCodeName | null;
  /** GST contained in amountCents (0 for GST-free codes). */
  gstCents: number;
  kind: "sales" | "refund" | "fees" | "adjustment" | "clearing";
  description: string;
  sources: { transactionIds: string[]; orderIds: string[]; ruleIds: string[]; skus: string[] };
}

export interface TransferPreview {
  fromKey: AccountKey;
  toKey: AccountKey;
  amountCents: number;
  txnDate: string;
  /** Carried in the QuickBooks PrivateNote so the transfer can be found again (idempotency). */
  reference: string;
}

export interface JournalPreview {
  version: 1;
  channel: string;
  payoutId: string;
  docNumber: string;
  txnDate: string;
  memo: string;
  lines: JournalLine[];
  totalDebitCents: number;
  totalCreditCents: number;
  netPayoutCents: number;
  clearingKey: AccountKey;
  transfer: TransferPreview;
  /** Foreign-currency sales in this payout, with the marketplace's conversion (FX rule). */
  fx: { orderId: string; currency: string; foreignAmount: string; rate: string | null; audCents: number; source: string }[];
}

/** QuickBooks DocNumber (max 21 chars): EB-<payout> / SP-<payout>. */
export const docNumberFor = (channel: string, payoutId: string) => `${channel === "ebay" ? "EB" : "SP"}-${payoutId}`.slice(0, 21);

type Acc = { cents: number; sources: JournalLine["sources"]; kind: JournalLine["kind"]; taxCode: TaxCodeName | null; account: AccountKey };

function add(map: Map<string, Acc>, key: string, account: AccountKey, taxCode: TaxCodeName | null, kind: JournalLine["kind"], cents: number, src: Partial<JournalLine["sources"]>) {
  const a = map.get(key) ?? { cents: 0, kind, taxCode, account, sources: { transactionIds: [], orderIds: [], ruleIds: [], skus: [] } };
  a.cents += cents;
  for (const k of ["transactionIds", "orderIds", "ruleIds", "skus"] as const) {
    for (const v of src[k] ?? []) if (v && !a.sources[k].includes(v)) a.sources[k].push(v);
  }
  map.set(key, a);
}

const gstFor = (cents: number, taxCode: TaxCodeName | null) => (taxRateBp(taxCode) === 1000 ? gstInclusive(cents) : 0);

/**
 * Build the journal and transfer for a payout. Lines whose category isn't
 * classified are left out; the posting gate refuses such payouts, so an
 * incomplete preview is never posted.
 */
export function buildJournalPreview(r: PayoutReport): JournalPreview {
  // Signed "credit-positive" amounts per journal line key.
  const credit = new Map<string, Acc>();
  for (const l of r.baseline?.lines ?? []) {
    const src = { transactionIds: [l.sourceTransactionId ?? ""], orderIds: [l.orderId ?? ""], ruleIds: [l.ruleId ?? ""], skus: [l.sku ?? ""] };
    if (l.kind === "item" || l.kind === "shipping") {
      const account = SALES_ACCOUNT[l.category];
      if (!account) continue;
      add(credit, `sales|${account}`, account, ACCOUNT_DEFS[account].taxCode, "sales", l.cents, src);
    } else if (l.kind === "refund") {
      const account = l.reversesCategory ? SALES_ACCOUNT[l.reversesCategory] : undefined;
      if (!account) continue;
      add(credit, `refund|${account}`, account, ACCOUNT_DEFS[account].taxCode, "refund", l.cents, src);
    } else if (l.kind === "adjustment" && l.category === "MARKETPLACE_ADJUSTMENTS") {
      add(credit, "adjustment|MARKETPLACE_ADJUSTMENTS", "MARKETPLACE_ADJUSTMENTS", null, "adjustment", l.cents, src);
    }
  }
  const channel = r.channel;
  for (const f of r.fees) {
    if (!f.taxCode) continue; // unknown fee type: the gate blocks
    const account = FEE_ACCOUNT[channel][f.category];
    const tax = FEE_TAX_CODE[f.taxCode];
    add(credit, `fees|${account}|${tax}`, account, tax, "fees", -f.cents, { transactionIds: [f.source.transactionId ?? ""], orderIds: [f.orderId ?? ""] });
  }
  const order = ["sales", "refund", "fees", "adjustment"];
  const lines: JournalLine[] = [...credit.values()]
    .filter((a) => a.cents !== 0)
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.account.localeCompare(b.account))
    .map((a) => {
      const amount = Math.abs(a.cents);
      const def = ACCOUNT_DEFS[a.account];
      return {
        accountKey: a.account,
        accountName: def.name,
        postingType: a.cents > 0 ? ("Credit" as const) : ("Debit" as const),
        amountCents: amount,
        taxCode: a.taxCode,
        gstCents: gstFor(amount, a.taxCode),
        kind: a.kind,
        description:
          a.kind === "sales"
            ? `${def.name}: sales and shipping`
            : a.kind === "refund"
              ? `${def.name}: refunds`
              : a.kind === "fees"
                ? `${def.name} (${a.taxCode})`
                : "Marketplace adjustments",
        sources: a.sources,
      };
    });
  const clearingKey = CLEARING_FOR[channel];
  const net = r.netCents;
  lines.push({
    accountKey: clearingKey,
    accountName: ACCOUNT_DEFS[clearingKey].name,
    postingType: net >= 0 ? "Debit" : "Credit",
    amountCents: Math.abs(net),
    taxCode: null,
    gstCents: 0,
    kind: "clearing",
    description: `Net payout ${r.payoutId}`,
    sources: { transactionIds: [], orderIds: [], ruleIds: [], skus: [] },
  });
  const sum = (t: "Debit" | "Credit") => lines.filter((l) => l.postingType === t).reduce((a, l) => a + l.amountCents, 0);
  const doc = docNumberFor(channel, r.payoutId);
  const fxSales: JournalPreview["fx"] = r.fx ?? [];
  return {
    version: 1,
    channel,
    payoutId: r.payoutId,
    docNumber: doc,
    txnDate: r.payoutDate,
    memo: `${channel === "ebay" ? "eBay" : "Shopify Payments"} payout ${r.payoutId} (LOFI reconciliation)`,
    lines,
    totalDebitCents: sum("Debit"),
    totalCreditCents: sum("Credit"),
    netPayoutCents: net,
    clearingKey,
    transfer: { fromKey: clearingKey, toKey: "BANK", amountCents: net, txnDate: r.payoutDate, reference: `LOFI-PAYOUT ${doc}` },
    fx: fxSales,
  };
}

/** Stable fingerprint of what would be posted (accounting content only). */
export async function fingerprint(p: JournalPreview): Promise<string> {
  const content = JSON.stringify({
    d: p.txnDate,
    n: p.docNumber,
    net: p.netPayoutCents,
    l: p.lines.map((l) => [l.accountKey, l.postingType, l.amountCents, l.taxCode]),
  });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The hard posting gate. Empty = may be approved and posted. A balanced
 * payout is necessary but not sufficient.
 */
export function gateReasons(r: PayoutReport, p: JournalPreview): string[] {
  const reasons: string[] = [];
  if (r.differenceCents !== 0) reasons.push(`The payout doesn't reconcile: difference ${(r.differenceCents / 100).toFixed(2)}`);
  if (!r.baseline) reasons.push("No classified split for this payout (fetch it again)");
  else if (r.baseline.unclassifiedCount > 0) reasons.push(`${r.baseline.unclassifiedCount} line(s) aren't classified`);
  const blocking = [...new Set(r.issues.filter((i) => i.severity === "blocking").map((i) => i.code))];
  if (blocking.length) reasons.push(`Blocking review issues: ${blocking.join(", ")}`);
  if (r.fees.some((f) => !f.taxCode)) reasons.push("A fee type isn't in the fee GST table");
  if (p.totalDebitCents !== p.totalCreditCents) reasons.push(`The journal doesn't balance (debits ${p.totalDebitCents}, credits ${p.totalCreditCents})`);
  const clearing = p.lines.find((l) => l.kind === "clearing")!;
  if ((clearing.postingType === "Debit" ? 1 : -1) * clearing.amountCents !== r.netCents) reasons.push("The clearing movement doesn't equal the payout");
  if (r.netCents <= 0) reasons.push("The payout is zero or negative: needs a person");
  return reasons;
}
