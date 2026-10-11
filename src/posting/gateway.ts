// The only path to QuickBooks. Business logic talks to this interface; the
// default is the dry-run gateway, which refuses every write. A real gateway
// is used only when QBO_MODE is "sandbox" or "live" AND credentials exist.

import type { AccountKey, TaxCodeName } from "./accounts";
import { taxAppliesTo } from "./accounts";
import type { JournalPreview } from "./journal";

export type QboMode = "dry_run" | "sandbox" | "live";

export interface QboJournalInput {
  docNumber: string;
  txnDate: string;
  privateNote: string;
  lines: {
    accountId: string;
    postingType: "Debit" | "Credit";
    amountCents: number;
    taxCodeId: string | null;
    taxApplicableOn: "Sales" | "Purchase" | null;
    gstCents: number;
    description: string;
  }[];
}

export interface QboTransferInput {
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  txnDate: string;
  privateNote: string;
}

export interface QboGateway {
  readonly mode: QboMode;
  findJournalByDocNumber(docNumber: string): Promise<{ id: string } | null>;
  createJournal(j: QboJournalInput): Promise<{ id: string }>;
  getJournal(id: string): Promise<{ id: string; totalCents: number } | null>;
  /** Find a transfer by the reference carried in its PrivateNote. */
  findTransfer(reference: string, txnDate: string, amountCents: number): Promise<{ id: string } | null>;
  createTransfer(t: QboTransferInput): Promise<{ id: string }>;
  getTransfer(id: string): Promise<{ id: string; amountCents: number } | null>;
}

/** Default gateway: never writes, never calls QuickBooks. */
export class DryRunGateway implements QboGateway {
  readonly mode = "dry_run" as const;
  private refuse(): never {
    throw new Error("Posting is switched off (dry-run mode). Set QBO_MODE to sandbox or live to enable it.");
  }
  async findJournalByDocNumber(): Promise<null> {
    return this.refuse();
  }
  async createJournal(): Promise<{ id: string }> {
    return this.refuse();
  }
  async getJournal(): Promise<null> {
    return this.refuse();
  }
  async findTransfer(): Promise<null> {
    return this.refuse();
  }
  async createTransfer(): Promise<{ id: string }> {
    return this.refuse();
  }
  async getTransfer(): Promise<null> {
    return this.refuse();
  }
}

export interface IdMaps {
  accounts: Map<AccountKey, string>;
  taxCodes: Map<TaxCodeName, string>;
}

/** Every account and tax code a preview needs must have a QuickBooks ID before posting. */
export function missingIds(p: JournalPreview, ids: IdMaps): string[] {
  const missing = new Set<string>();
  for (const l of p.lines) {
    if (!ids.accounts.has(l.accountKey)) missing.add(`account ${l.accountKey}`);
    if (l.taxCode && !ids.taxCodes.has(l.taxCode)) missing.add(`tax code "${l.taxCode}"`);
  }
  if (!ids.accounts.has(p.transfer.toKey)) missing.add(`account ${p.transfer.toKey}`);
  return [...missing];
}

export function toQboJournal(p: JournalPreview, ids: IdMaps): QboJournalInput {
  const miss = missingIds(p, ids);
  if (miss.length) throw new Error(`QuickBooks IDs not configured: ${miss.join(", ")}`);
  return {
    docNumber: p.docNumber,
    txnDate: p.txnDate,
    privateNote: `${p.memo}. ${p.transfer.reference}`,
    lines: p.lines.map((l) => ({
      accountId: ids.accounts.get(l.accountKey)!,
      postingType: l.postingType,
      amountCents: l.amountCents,
      taxCodeId: l.taxCode ? ids.taxCodes.get(l.taxCode)! : null,
      taxApplicableOn: taxAppliesTo(l.taxCode),
      gstCents: l.gstCents,
      description: l.description,
    })),
  };
}

export function toQboTransfer(p: JournalPreview, ids: IdMaps): QboTransferInput {
  return {
    fromAccountId: ids.accounts.get(p.transfer.fromKey)!,
    toAccountId: ids.accounts.get(p.transfer.toKey)!,
    amountCents: p.transfer.amountCents,
    txnDate: p.transfer.txnDate,
    privateNote: p.transfer.reference,
  };
}
