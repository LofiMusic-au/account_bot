// Rebuilds a payout into its sales, refunds, fees and adjustments, applies the
// GST rules to every line, and checks the pieces add up to the bank deposit
// to the cent. Report-only: nothing is posted anywhere.
//
//   items (after discounts) + shipping       = sales collected
//   - refunds
//   - marketplace, payment, advertising, shipping-label and other fees
//   +/- adjustments (supported and unsupported)
//   = expected settlement, compared with the actual payout.

import { classifyOrder, rescaleOrder, type StockResolver } from "./rules/engine";
import { FEE_TAX, SCENARIOS } from "./rules/config";
import type {
  Adjustment,
  Channel,
  Fee,
  FeeCategory,
  Issue,
  LineClassification,
  NormalisedPayout,
  ScenarioCode,
  TaxCode,
} from "./types";

export type ReportStatus = "ready" | "needs_review" | "unbalanced";
export const REPORT_VERSION = 2;

export interface ScenarioTotal {
  code: ScenarioCode | "SHIPPING";
  name: string;
  count: number;
  grossCents: number;
  gstCents: number;
  signedOff: boolean;
}

export const FEE_CATEGORIES: FeeCategory[] = ["marketplace", "payment", "advertising", "shipping_label", "other"];

export interface PayoutBreakdown {
  itemsCents: number;
  shippingCents: number;
  /** Discounts already taken off the items (informational, not subtracted again). */
  discountsCents: number;
  salesGrossCents: number;
  refundsCents: number;
  feesByCategory: Record<FeeCategory, number>;
  feesCents: number;
  adjustmentsCents: number;
  unsupportedCents: number;
}

export interface PayoutReport {
  version: number;
  channel: Channel;
  payoutId: string;
  payoutDate: string;
  netCents: number;
  rawAmount: string;
  rawCurrency: string;
  expectedCents: number;
  differenceCents: number;
  status: ReportStatus;
  /** True while any treatment used is unsigned-off. Never cleared by staff. */
  provisional: boolean;
  sales: LineClassification[];
  refunds: LineClassification[];
  fees: (Fee & { taxCode: TaxCode })[];
  adjustments: Adjustment[];
  breakdown: PayoutBreakdown;
  totals: {
    salesGrossCents: number;
    refundsCents: number;
    feesCents: number;
    adjustmentsCents: number;
    gstCents: number;
    notionalItcCents: number;
    byScenario: ScenarioTotal[];
  };
  saleCount: number;
  lineCount: number;
  /** Sale and refund lines a person must classify. */
  reviewCount: number;
  issues: Issue[];
  blockingCount: number;
  signoffCount: number;
  warnings: string[];
  sourceTransactionCount: number;
  generatedAt: string;
}

const issueKey = (i: Issue) =>
  [i.code, i.severity, i.message, i.orderId ?? "", i.lineId ?? "", i.transactionId ?? "", i.sku ?? ""].join("|");

export function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Map<string, Issue>();
  for (const i of issues) if (!seen.has(issueKey(i))) seen.set(issueKey(i), i);
  // Blocking first, then sign-off; stable within each.
  return [...seen.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));
}

export function buildReport(payout: NormalisedPayout, resolve: StockResolver, now = new Date()): PayoutReport {
  const warnings = [...payout.warnings];
  const issues: Issue[] = [...payout.issues];

  const sales = payout.sales.flatMap((o) => {
    const lines = classifyOrder(o, resolve);
    const sum = lines.reduce((a, l) => a + l.grossCents, 0);
    if (sum !== o.grossCents) {
      issues.push({
        code: "order_lines_mismatch",
        severity: "blocking",
        message: `${o.orderName}: lines and shipping add to ${sum} cents but the order collected ${o.grossCents} cents`,
        orderId: o.orderId,
        cents: o.grossCents - sum,
      });
    }
    return lines;
  });

  const refunds = payout.refunds.flatMap((r): LineClassification[] => {
    if (!r.order) {
      const msg = "Refund can't be matched to its original sale";
      return [
        {
          orderId: r.orderId,
          orderName: r.orderName,
          lineId: `${r.orderId}:refund`,
          kind: "item",
          sku: null,
          title: "Refund (original order not found)",
          scenario: "REVIEW",
          approval: "review",
          reason: msg,
          explanation: ["original order = not found", `→ needs review: ${msg}`],
          grossCents: -r.cents,
          discountCents: 0,
          gstCents: 0,
          postings: [],
          notionalItcCents: 0,
          division66Candidate: false,
          flags: [],
          issues: [
            { code: "refund_unmatched", severity: "blocking", message: msg, orderId: r.orderId, transactionId: r.source.transactionId, cents: -r.cents },
          ],
          sources: [r.source],
        },
      ];
    }
    // D3: reverse using the same scenarios as the original sale.
    return classifyOrder({ ...rescaleOrder(r.order, -r.cents), sources: [r.source] }, resolve).map((l) => ({
      ...l,
      lineId: `${l.lineId}:refund:${r.source.transactionId ?? ""}`,
      title: `Refund: ${l.title}`,
      explanation: ["refund reverses the original sale's scenario (D3)", ...l.explanation],
      flags: [...l.flags, "Refund reverses the original sale's scenario (D3)"],
    }));
  });

  const fees = payout.fees.map((f) => ({ ...f, taxCode: FEE_TAX[f.type] ?? ("PENDING" as TaxCode) }));
  for (const type of new Set(fees.filter((f) => f.taxCode === "PENDING").map((f) => f.type))) {
    issues.push({
      code: "unknown_fee_tax",
      severity: "signoff",
      message:
        type in FEE_TAX
          ? `Fee type ${type}: GST treatment awaiting the accountant (D1)`
          : `Fee type ${type} isn't in the fee GST table (D1)`,
    });
  }

  const all = [...sales, ...refunds];
  for (const l of all) issues.push(...l.issues);

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const saleItems = sales.filter((l) => l.kind === "item");
  const feesByCategory = Object.fromEntries(FEE_CATEGORIES.map((c) => [c, 0])) as Record<FeeCategory, number>;
  for (const f of payout.fees) feesByCategory[f.category] += f.cents;

  const salesGrossCents = sum(payout.sales.map((s) => s.grossCents));
  const refundsCents = sum(payout.refunds.map((r) => r.cents));
  const feesCents = sum(payout.fees.map((f) => f.cents));
  const adjustmentsCents = sum(payout.adjustments.filter((a) => a.supported).map((a) => a.cents));
  const unsupportedCents = sum(payout.adjustments.filter((a) => !a.supported).map((a) => a.cents));
  const expectedCents = salesGrossCents - refundsCents - feesCents + adjustmentsCents + unsupportedCents;
  const differenceCents = payout.netCents - expectedCents;
  if (differenceCents !== 0) {
    issues.push({
      code: "payout_mismatch",
      severity: "blocking",
      message: `Payout is ${payout.netCents} cents but the transactions add to ${expectedCents} cents`,
      cents: differenceCents,
    });
  }

  const byScenarioMap = new Map<ScenarioTotal["code"], ScenarioTotal>();
  for (const l of all) {
    const code: ScenarioTotal["code"] = l.kind === "shipping" ? "SHIPPING" : l.scenario;
    const t = byScenarioMap.get(code) ?? {
      code,
      name: code === "SHIPPING" ? "Shipping charged to buyers (follows the items)" : SCENARIOS[code].name,
      count: 0,
      grossCents: 0,
      gstCents: 0,
      signedOff: code === "SHIPPING" ? false : SCENARIOS[code].signedOff,
    };
    t.count++;
    t.grossCents += l.grossCents;
    t.gstCents += l.gstCents;
    byScenarioMap.set(code, t);
  }

  const deduped = dedupeIssues(issues);
  const blockingCount = deduped.filter((i) => i.severity === "blocking").length;
  const signoffCount = deduped.length - blockingCount;
  const reviewCount = all.filter((l) => l.approval === "review").length;
  const status: ReportStatus =
    differenceCents !== 0 ? "unbalanced" : blockingCount > 0 || reviewCount > 0 ? "needs_review" : "ready";
  const provisional = signoffCount > 0 || all.some((l) => l.approval !== "approved");

  return {
    version: REPORT_VERSION,
    channel: payout.channel,
    payoutId: payout.payoutId,
    payoutDate: payout.payoutDate,
    netCents: payout.netCents,
    rawAmount: payout.rawAmount,
    rawCurrency: payout.rawCurrency,
    expectedCents,
    differenceCents,
    status,
    provisional,
    sales,
    refunds,
    fees,
    adjustments: payout.adjustments,
    breakdown: {
      itemsCents: sum(saleItems.map((l) => l.grossCents)),
      shippingCents: sum(payout.sales.map((s) => s.shippingCents)),
      discountsCents: sum(saleItems.map((l) => l.discountCents)),
      salesGrossCents,
      refundsCents,
      feesByCategory,
      feesCents,
      adjustmentsCents,
      unsupportedCents,
    },
    totals: {
      salesGrossCents,
      refundsCents,
      feesCents,
      adjustmentsCents: adjustmentsCents + unsupportedCents,
      gstCents: sum(all.map((l) => l.gstCents)),
      notionalItcCents: sum(all.map((l) => l.notionalItcCents)),
      byScenario: [...byScenarioMap.values()].sort((a, b) => a.code.localeCompare(b.code)),
    },
    saleCount: payout.sales.length,
    lineCount: saleItems.length,
    reviewCount,
    issues: deduped,
    blockingCount,
    signoffCount,
    warnings,
    sourceTransactionCount: payout.raw.transactions.length,
    generatedAt: now.toISOString(),
  };
}

/** Scenario counts over sold item lines only (no shipping, no refunds). */
export function saleScenarioCounts(r: Pick<PayoutReport, "sales">): [string, number][] {
  const m = new Map<string, number>();
  for (const l of r.sales) if (l.kind === "item") m.set(l.scenario, (m.get(l.scenario) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}
