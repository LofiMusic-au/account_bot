// QuickBooks Online REST gateway (sandbox or live). Reached only when
// QBO_MODE is "sandbox" or "live", credentials are set, AND a person has
// approved the payout. Not exercised against QuickBooks yet.
//
// UNVERIFIED until run against an Intuit sandbox company:
//   * how AU GST is carried on JournalEntry lines (TaxCodeRef +
//     TaxApplicableOn + TaxAmount with GlobalTaxCalculation "TaxInclusive"),
//   * the JournalEntry / Transfer query syntax used for idempotent lookups.
// Validate both in the sandbox before any live use.

import { centsToDecimal, toCents } from "../money";
import type { QboGateway, QboJournalInput, QboMode, QboTransferInput } from "./gateway";

export interface QboHttpConfig {
  mode: Exclude<QboMode, "dry_run">;
  realmId: string;
  clientId: string;
  clientSecret: string;
  /** Returns the current refresh token and stores a rotated one. */
  tokens: { get(): Promise<string>; set(token: string): Promise<void> };
  fetch?: typeof fetch;
  minorVersion?: number;
}

export class QboHttpGateway implements QboGateway {
  readonly mode: Exclude<QboMode, "dry_run">;
  private access: { token: string; expires: number } | null = null;
  constructor(private cfg: QboHttpConfig) {
    this.mode = cfg.mode;
  }

  private get base() {
    const host = this.cfg.mode === "live" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
    return `${host}/v3/company/${encodeURIComponent(this.cfg.realmId)}`;
  }

  private doFetch(input: string, init?: RequestInit) {
    const f = this.cfg.fetch ?? fetch;
    return f(input, init);
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expires > Date.now() + 120_000) return this.access.token;
    const refresh = await this.cfg.tokens.get();
    const res = await this.doFetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`)}`,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    });
    if (!res.ok) throw new Error(`QuickBooks token ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    if (body.refresh_token && body.refresh_token !== refresh) await this.cfg.tokens.set(body.refresh_token); // Intuit rotates them
    this.access = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await this.doFetch(`${this.base}${path}${sep}minorversion=${this.cfg.minorVersion ?? 75}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`QuickBooks ${res.status} ${path.split("?")[0]}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 300)}`);
    return (await res.json()) as T;
  }

  private query<T>(q: string) {
    return this.call<{ QueryResponse: Record<string, T[] | undefined> }>("GET", `/query?query=${encodeURIComponent(q)}`);
  }

  async findJournalByDocNumber(docNumber: string) {
    const r = await this.query<{ Id: string }>(`select Id from JournalEntry where DocNumber = '${docNumber.replace(/'/g, "")}'`);
    const hit = r.QueryResponse.JournalEntry?.[0];
    return hit ? { id: hit.Id } : null;
  }

  async createJournal(j: QboJournalInput) {
    const body = {
      DocNumber: j.docNumber,
      TxnDate: j.txnDate,
      PrivateNote: j.privateNote,
      GlobalTaxCalculation: "TaxInclusive",
      Line: j.lines.map((l) => ({
        DetailType: "JournalEntryLineDetail",
        Amount: Number(centsToDecimal(l.amountCents)),
        Description: l.description,
        JournalEntryLineDetail: {
          PostingType: l.postingType,
          AccountRef: { value: l.accountId },
          ...(l.taxCodeId ? { TaxCodeRef: { value: l.taxCodeId }, TaxApplicableOn: l.taxApplicableOn, TaxAmount: Number(centsToDecimal(l.gstCents)) } : {}),
        },
      })),
    };
    const r = await this.call<{ JournalEntry: { Id: string } }>("POST", "/journalentry", body);
    return { id: r.JournalEntry.Id };
  }

  async getJournal(id: string) {
    try {
      const r = await this.call<{ JournalEntry: { Id: string; Line: { Amount: number; JournalEntryLineDetail?: { PostingType: string } }[] } }>(
        "GET",
        `/journalentry/${encodeURIComponent(id)}`,
      );
      const debits = r.JournalEntry.Line.filter((l) => l.JournalEntryLineDetail?.PostingType === "Debit").reduce((a, l) => a + toCents(String(l.Amount)), 0);
      return { id: r.JournalEntry.Id, totalCents: debits };
    } catch {
      return null;
    }
  }

  async findTransfer(reference: string, txnDate: string, amountCents: number) {
    const r = await this.query<{ Id: string; PrivateNote?: string; Amount: number }>(`select * from Transfer where TxnDate = '${txnDate}'`);
    const hit = (r.QueryResponse.Transfer ?? []).find((t) => (t.PrivateNote ?? "").includes(reference) && toCents(String(t.Amount)) === amountCents);
    return hit ? { id: hit.Id } : null;
  }

  async createTransfer(t: QboTransferInput) {
    const r = await this.call<{ Transfer: { Id: string } }>("POST", "/transfer", {
      FromAccountRef: { value: t.fromAccountId },
      ToAccountRef: { value: t.toAccountId },
      Amount: Number(centsToDecimal(t.amountCents)),
      TxnDate: t.txnDate,
      PrivateNote: t.privateNote,
    });
    return { id: r.Transfer.Id };
  }

  async getTransfer(id: string) {
    try {
      const r = await this.call<{ Transfer: { Id: string; Amount: number } }>("GET", `/transfer/${encodeURIComponent(id)}`);
      return { id: r.Transfer.Id, amountCents: toCents(String(r.Transfer.Amount)) };
    } catch {
      return null;
    }
  }
}
