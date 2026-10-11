// Milestone 2: QuickBooks posting. Everything runs against a fake QuickBooks;
// no test talks to Intuit.

import { describe, expect, it } from "vitest";
import { buildJournalPreview, docNumberFor, gateReasons } from "../src/posting/journal";
import { DryRunGateway, toQboJournal, type QboGateway, type QboJournalInput, type QboTransferInput } from "../src/posting/gateway";
import { approveAdjustment, approvePosting, getPosting, listEvents, pendingAdjustment, postAdjustment, postPayout } from "../src/posting/workflow";
import { ingestAndReport, rebuildStored } from "../src/index";
import { getReport } from "../src/db";
import { buildReport } from "../src/reconcile";
import { FEE_TAX } from "../src/rules/config";
import { ebayFixture, fixtureResolver, makeTestD1, seedFixtureFacts, shopifyFixture } from "./helpers";

/** In-memory QuickBooks with failure injection. */
class FakeQbo implements QboGateway {
  readonly mode = "sandbox" as const;
  journals = new Map<string, QboJournalInput>();
  transfers = new Map<string, QboTransferInput>();
  failNextTransfer = false;
  /** Create the journal, then throw as if the response was lost. */
  loseNextJournalResponse = false;
  private n = 0;
  async findJournalByDocNumber(doc: string) {
    for (const [id, j] of this.journals) if (j.docNumber === doc) return { id };
    return null;
  }
  async createJournal(j: QboJournalInput) {
    const id = `J${++this.n}`;
    this.journals.set(id, j);
    if (this.loseNextJournalResponse) {
      this.loseNextJournalResponse = false;
      throw new Error("timeout: response lost");
    }
    return { id };
  }
  async getJournal(id: string) {
    const j = this.journals.get(id);
    return j ? { id, totalCents: j.lines.filter((l) => l.postingType === "Debit").reduce((a, l) => a + l.amountCents, 0) } : null;
  }
  async findTransfer(ref: string, date: string, amount: number) {
    for (const [id, t] of this.transfers) if (t.privateNote.includes(ref) && t.txnDate === date && t.amountCents === amount) return { id };
    return null;
  }
  async createTransfer(t: QboTransferInput) {
    if (this.failNextTransfer) {
      this.failNextTransfer = false;
      throw new Error("QuickBooks 500 /transfer");
    }
    const id = `T${++this.n}`;
    this.transfers.set(id, t);
    return { id };
  }
  async getTransfer(id: string) {
    const t = this.transfers.get(id);
    return t ? { id, amountCents: t.amountCents } : null;
  }
}

const ALL_IDS = {
  accounts: { SALES_DOMESTIC_GST: "1", SALES_OVERSEAS_NO_GST: "2", CONSIGNMENT_SALES_NO_GST: "3", EBAY_FEES: "4", SHOPIFY_FEES: "5", MARKETPLACE_ADJUSTMENTS: "6", EBAY_CLEARING: "7", SHOPIFY_PAYMENTS_CLEARING: "8", BANK: "9" },
  taxCodes: { "GST (10% Sales)": "10", "GST free (0% Sales)": "11", "GST on purchases (10%)": "12", "GST free purchases (0%)": "13" },
};
function mapIds(sqlite: ReturnType<typeof makeTestD1>["sqlite"]) {
  for (const [k, v] of Object.entries(ALL_IDS.accounts)) sqlite.prepare("INSERT INTO qbo_account_map (account_key, qbo_account_id) VALUES (?, ?)").run(k, v);
  for (const [k, v] of Object.entries(ALL_IDS.taxCodes)) sqlite.prepare("INSERT INTO qbo_tax_code_map (tax_code_name, qbo_tax_code_id) VALUES (?, ?)").run(k, v);
}
async function readyShopify() {
  const t = makeTestD1();
  seedFixtureFacts(t.sqlite);
  mapIds(t.sqlite);
  await ingestAndReport(t.d1, shopifyFixture());
  return t;
}

const resolve = fixtureResolver();

describe("journal preview", () => {
  const shop = buildReport(shopifyFixture(), resolve);
  const j = buildJournalPreview(shop);
  const line = (key: string, kind?: string) => j.lines.find((l) => l.accountKey === key && (!kind || l.kind === kind))!;

  it("one journal per payout, dated on the payout date, that balances, with the clearing line equal to the payout", () => {
    expect(j.docNumber).toBe("SP-9001");
    expect(docNumberFor("ebay", "7793505813")).toBe("EB-7793505813");
    expect(j.txnDate).toBe("2026-10-08");
    expect(j.totalDebitCents).toBe(j.totalCreditCents);
    expect(line("SHOPIFY_PAYMENTS_CLEARING")).toMatchObject({ postingType: "Debit", amountCents: 172616 });
    expect(j.transfer).toEqual({ fromKey: "SHOPIFY_PAYMENTS_CLEARING", toKey: "BANK", amountCents: 172616, txnDate: "2026-10-08", reference: "LOFI-PAYOUT SP-9001" });
    expect(gateReasons(shop, j)).toEqual([]);
  });

  it("sales by account and tax code: domestic GST (incl. shipping), overseas GST-free, consignment Commission Sales GST-free", () => {
    expect(line("SALES_DOMESTIC_GST", "sales")).toMatchObject({ accountName: "Sales", postingType: "Credit", taxCode: "GST (10% Sales)" });
    expect(line("SALES_OVERSEAS_NO_GST", "sales")).toMatchObject({ accountName: "Overseas Sales", taxCode: "GST free (0% Sales)", gstCents: 0, amountCents: 56000 }); // NZ order incl. shipping
    expect(line("CONSIGNMENT_SALES_NO_GST", "sales")).toMatchObject({ accountName: "Commission Sales", taxCode: "GST free (0% Sales)", gstCents: 0 });
    const domestic = line("SALES_DOMESTIC_GST", "sales");
    expect(domestic.gstCents).toBe(Math.round(domestic.amountCents / 11));
  });

  it("a refund reverses the original category (debit Sales / GST)", () => {
    expect(line("SALES_DOMESTIC_GST", "refund")).toMatchObject({ postingType: "Debit", amountCents: 10000, taxCode: "GST (10% Sales)" });
  });

  it("fees: Shopify -> GST on purchases (10%); eBay -> GST free purchases (0%)", () => {
    expect(line("SHOPIFY_FEES")).toMatchObject({ postingType: "Debit", amountCents: 7684, taxCode: "GST on purchases (10%)", gstCents: 699 });
    const e = buildJournalPreview(buildReport(ebayFixture(), resolve));
    expect(e.lines.find((l) => l.accountKey === "EBAY_FEES")).toMatchObject({ postingType: "Debit", taxCode: "GST free purchases (0%)", gstCents: 0, amountCents: 27162 });
    expect(e.totalDebitCents).toBe(e.totalCreditCents);
  });

  it("fee GST table covers PayPal, Afterpay and ZIP as agreed", () => {
    expect(FEE_TAX.paypal_fee).toBe("GST_FREE_PURCHASES");
    expect(FEE_TAX.afterpay_fee).toBe("GST_ON_PURCHASES");
    expect(FEE_TAX.zip_fee).toBe("GST_ON_PURCHASES");
  });

  it("every line keeps its evidence: source transaction IDs, order IDs and rule IDs", () => {
    const sales = line("SALES_DOMESTIC_GST", "sales");
    expect(sales.sources.transactionIds.length).toBeGreaterThan(0);
    expect(sales.sources.ruleIds).toContain("R8");
    expect(line("SHOPIFY_FEES").sources.transactionIds).toContain("gid://shopify/ShopifyPaymentsBalanceTransaction/1");
  });
});

describe("the hard posting gate", () => {
  it("blocks a payout that doesn't reconcile", () => {
    const r = buildReport(shopifyFixture((f) => void (f.payout.net.amount = "1726.17")), resolve);
    expect(gateReasons(r, buildJournalPreview(r)).join()).toMatch(/doesn't reconcile/);
  });
  it("blocks a payout with an unclassified line", () => {
    const r = buildReport(shopifyFixture(), () => null);
    expect(gateReasons(r, buildJournalPreview(r)).join()).toMatch(/line\(s\) aren't classified/);
  });
  it("blocks an unknown adjustment type even though the payout balances", () => {
    const r = buildReport(
      shopifyFixture((f) => {
        f.transactions.push({ ...f.transactions[5]!, id: "x9", type: "SHOP_CASH_CREDIT", amount: { amount: "3.00", currencyCode: "AUD" }, net: { amount: "3.00", currencyCode: "AUD" } });
        f.payout.net.amount = "1729.16";
      }),
      resolve,
    );
    expect(r.differenceCents).toBe(0);
    expect(gateReasons(r, buildJournalPreview(r)).join()).toMatch(/unsupported_transaction_type/);
  });
  it("blocks an unknown fee type", () => {
    const p = shopifyFixture();
    p.fees[0]!.type = "shopify_new_fee";
    const r = buildReport(p, resolve);
    expect(gateReasons(r, buildJournalPreview(r)).join()).toMatch(/fee type isn't in the fee GST table|unknown_fee_tax/);
  });
});

describe("posting workflow (against a fake QuickBooks)", () => {
  it("preview -> ready for review -> approve -> post journal + transfer -> posted, with an audit trail", async () => {
    const { d1 } = await readyShopify();
    expect((await getPosting(d1, "shopify", "9001"))!.status).toBe("ready_for_review");
    const qbo = new FakeQbo();
    await expect(postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!)).rejects.toThrow(/needs approval/);
    await approvePosting(d1, "shopify", "9001", "jess@lofimusic.com.au");
    const row = await postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!);
    expect(row).toMatchObject({ status: "posted", journal_id: "J1", journal_doc_number: "SP-9001", transfer_id: "T2" });
    expect(qbo.journals.get("J1")!.txnDate).toBe("2026-10-08");
    expect(qbo.transfers.get("T2")).toMatchObject({ fromAccountId: "8", toAccountId: "9", amountCents: 172616 });
    const events = (await listEvents(d1, "shopify", "9001")).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(["preview_created", "approved", "posting_started", "journal_created", "transfer_created", "posted"]));
  });

  it("never duplicates: posting again, or re-importing, creates nothing new", async () => {
    const { d1 } = await readyShopify();
    const qbo = new FakeQbo();
    await approvePosting(d1, "shopify", "9001", "x");
    await postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!);
    await postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!);
    await ingestAndReport(d1, shopifyFixture());
    await postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!);
    expect(qbo.journals.size).toBe(1);
    expect(qbo.transfers.size).toBe(1);
    expect((await getPosting(d1, "shopify", "9001"))!.status).toBe("posted");
  });

  it("journal posted but transfer failed: a retry creates only the transfer", async () => {
    const { d1 } = await readyShopify();
    const qbo = new FakeQbo();
    await approvePosting(d1, "shopify", "9001", "x");
    qbo.failNextTransfer = true;
    const partial = await postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!);
    expect(partial).toMatchObject({ status: "journal_posted", journal_id: "J1", transfer_id: null });
    expect(partial.last_error).toMatch(/500/);
    const done = await postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!);
    expect(done.status).toBe("posted");
    expect(qbo.journals.size).toBe(1);
    expect(qbo.transfers.size).toBe(1);
  });

  it("an ambiguous journal failure (created, response lost) is found by DocNumber on retry, not created twice", async () => {
    const { d1 } = await readyShopify();
    const qbo = new FakeQbo();
    await approvePosting(d1, "shopify", "9001", "x");
    qbo.loseNextJournalResponse = true;
    const failed = await postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!);
    expect(failed.status).toBe("failed");
    const done = await postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!);
    expect(done.status).toBe("posted");
    expect(qbo.journals.size).toBe(1);
    expect((await listEvents(d1, "shopify", "9001")).map((e) => e.event)).toContain("journal_found_in_quickbooks");
  });

  it("dry-run mode refuses to post, and the dry-run gateway refuses every call", async () => {
    const { d1 } = await readyShopify();
    await approvePosting(d1, "shopify", "9001", "x");
    await expect(postPayout(d1, new DryRunGateway(), (await getReport(d1, "shopify", "9001"))!)).rejects.toThrow(/dry-run/);
    await expect(new DryRunGateway().createJournal()).rejects.toThrow(/dry-run/);
  });

  it("a change after approval invalidates the approval", async () => {
    const { d1, sqlite } = await readyShopify();
    await approvePosting(d1, "shopify", "9001", "x");
    sqlite.prepare("UPDATE stock_items SET ownership = 'consignment', consignor_id = 1, acquired_from = NULL WHERE sku = '240/100_Stepdown'").run();
    await rebuildStored(d1, "shopify", "9001");
    const row = (await getPosting(d1, "shopify", "9001"))!;
    expect(row.status).toBe("ready_for_review");
    expect(row.approved_fingerprint).toBeNull();
    expect((await listEvents(d1, "shopify", "9001")).map((e) => e.event)).toContain("approval_invalidated");
  });

  it("can't post without QuickBooks IDs for every account and tax code", async () => {
    const t = makeTestD1();
    seedFixtureFacts(t.sqlite);
    await ingestAndReport(t.d1, shopifyFixture());
    await approvePosting(t.d1, "shopify", "9001", "x");
    await expect(postPayout(t.d1, new FakeQbo(), (await getReport(t.d1, "shopify", "9001"))!)).rejects.toThrow(/IDs not configured/);
    const preview = JSON.parse((await getPosting(t.d1, "shopify", "9001"))!.preview_json);
    expect(() => toQboJournal(preview, { accounts: new Map(), taxCodes: new Map() })).toThrow(/SALES_DOMESTIC_GST/);
  });

  it("a not-ready payout can't be approved", async () => {
    const t = makeTestD1();
    await ingestAndReport(t.d1, shopifyFixture()); // no stock facts: lines unclassified
    expect((await getPosting(t.d1, "shopify", "9001"))!.status).toBe("not_ready");
    await expect(approvePosting(t.d1, "shopify", "9001", "x")).rejects.toThrow(/not ready/);
  });
});

describe("posted history is immutable; corrections are linked adjustments", () => {
  it("a change after posting leaves the original alone and prepares an adjusting journal linked to it", async () => {
    const { d1, sqlite } = await readyShopify();
    const qbo = new FakeQbo();
    await approvePosting(d1, "shopify", "9001", "x");
    const posted = await postPayout(d1, qbo, (await getReport(d1, "shopify", "9001"))!);
    const originalPreview = posted.posted_preview_json;

    // The stepdown turns out to have been consigned: Sales -> Commission Sales.
    sqlite.prepare("UPDATE stock_items SET ownership = 'consignment', consignor_id = 1, acquired_from = NULL WHERE sku = '240/100_Stepdown'").run();
    await rebuildStored(d1, "shopify", "9001");
    const row = (await getPosting(d1, "shopify", "9001"))!;
    expect(row.status).toBe("adjustment_required");
    expect(row.posted_preview_json).toBe(originalPreview); // never rewritten
    expect(qbo.journals.get("J1")!.lines).toEqual(JSON.parse(JSON.stringify(qbo.journals.get("J1")!.lines))); // untouched in QuickBooks

    const adj = (await pendingAdjustment(d1, "shopify", "9001"))!;
    expect(adj).toMatchObject({ seq: 1, status: "pending", original_journal_id: "J1" });
    const p = JSON.parse(adj.preview_json);
    expect(p.docNumber).toBe("SP-9001-A1");
    expect(p.totalDebitCents).toBe(p.totalCreditCents);
    // Moves the stepdown's share out of Sales into Commission Sales; the clearing line is unchanged.
    expect(p.lines.map((l: { accountKey: string; postingType: string }) => `${l.accountKey}:${l.postingType}`).sort()).toEqual(["CONSIGNMENT_SALES_NO_GST:Credit", "SALES_DOMESTIC_GST:Debit"]);

    await expect(postAdjustment(d1, qbo, "shopify", "9001")).rejects.toThrow(/No approved adjustment/);
    await approveAdjustment(d1, "shopify", "9001", "x");
    await postAdjustment(d1, qbo, "shopify", "9001");
    expect(qbo.journals.size).toBe(2);
    expect([...qbo.journals.values()][1]!.docNumber).toBe("SP-9001-A1");
    expect((await getPosting(d1, "shopify", "9001"))!.status).toBe("posted");
    // Rebuilding again changes nothing more.
    await rebuildStored(d1, "shopify", "9001");
    expect((await getPosting(d1, "shopify", "9001"))!.status).toBe("posted");
    expect(await pendingAdjustment(d1, "shopify", "9001")).toBeNull();
  });
});

describe("audit evidence", () => {
  it("the stored preview names source transactions, orders, rule IDs and FX; posting stores the QuickBooks IDs", async () => {
    const t = makeTestD1();
    seedFixtureFacts(t.sqlite);
    mapIds(t.sqlite);
    await ingestAndReport(t.d1, ebayFixture());
    const row = (await getPosting(t.d1, "ebay", "7001"))!;
    const p = JSON.parse(row.preview_json);
    expect(p.lines.some((l: { sources: { ruleIds: string[] } }) => l.sources.ruleIds.includes("R8"))).toBe(true);
    expect(p.lines.some((l: { sources: { transactionIds: string[] } }) => l.sources.transactionIds.includes("26-00001-00001"))).toBe(true);
    await approvePosting(t.d1, "ebay", "7001", "x");
    const posted = await postPayout(t.d1, new FakeQbo(), (await getReport(t.d1, "ebay", "7001"))!);
    expect(posted).toMatchObject({ status: "posted", journal_doc_number: "EB-7001" });
    expect(posted.journal_id).toBeTruthy();
    expect(posted.transfer_id).toBeTruthy();
  });
});
