// Rebuilds a payout into its sales, refunds, fees and adjustments, applies the
// GST rules to every line, and checks the pieces add up to the bank deposit
// to the cent. Report-only: nothing is posted anywhere.

import { classifyOrder, rescaleOrder, type StockResolver } from "./rules/engine";
import { FEE_TAX, SCENARIOS } from "./rules/config";
import type { Adjustment, Fee, LineClassification, NormalisedPayout, ScenarioCode, TaxCode } from "./types";

export type ReportStatus = "ready" | "needs_review" | "unbalanced";

export interface ScenarioTotal {
  code: ScenarioCode;
  name: string;
  count: number;
  grossCents: number;
  gstCents: number;
}

export interface PayoutReport {
  channel: NormalisedPayout["channel"];
  payoutId: string;
  payoutDate: string;
  netCents: number;
  expectedCents: number;
  differenceCents: number;
  status: ReportStatus;
  sales: LineClassification[];
  refunds: LineClassification[];
  fees: (Fee & { taxCode: TaxCode })[];
  adjustments: Adjustment[];
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
  reviewCount: number;
  warnings: string[];
  generatedAt: string;
}

export function buildReport(payout: NormalisedPayout, resolve: StockResolver, now = new Date()): PayoutReport {
  const warnings = [...payout.warnings];

  const sales = payout.sales.flatMap((o) => {
    const lines = classifyOrder(o, resolve);
    const sum = lines.reduce((a, l) => a + l.grossCents, 0);
    if (sum !== o.grossCents) {
      warnings.push(`${o.orderName}: lines add to ${sum} cents but the order collected ${o.grossCents} cents`);
    }
    return lines;
  });

  const refunds = payout.refunds.flatMap((r): LineClassification[] => {
    if (!r.order) {
      return [
        {
          orderId: r.orderId,
          orderName: r.orderName,
          lineId: `${r.orderId}:refund`,
          sku: null,
          title: "Refund (original order not found)",
          scenario: "REVIEW",
          approval: "review",
          reason: "Refund can't be matched to its original sale",
          grossCents: -r.cents,
          gstCents: 0,
          postings: [],
          notionalItcCents: 0,
          flags: [],
        },
      ];
    }
    // D3: reverse using the same scenarios as the original sale.
    return classifyOrder(rescaleOrder(r.order, -r.cents), resolve).map((l) => ({
      ...l,
      lineId: `${l.lineId}:refund`,
      title: `Refund: ${l.title}`,
      flags: [...l.flags, "Refund reverses the original sale's scenario (D3)"],
    }));
  });

  const fees = payout.fees.map((f) => ({ ...f, taxCode: FEE_TAX[f.type] ?? ("PENDING" as TaxCode) }));

  const salesGrossCents = payout.sales.reduce((a, s) => a + s.grossCents, 0);
  const refundsCents = payout.refunds.reduce((a, r) => a + r.cents, 0);
  const feesCents = payout.fees.reduce((a, f) => a + f.cents, 0);
  const adjustmentsCents = payout.adjustments.reduce((a, x) => a + x.cents, 0);
  const expectedCents = salesGrossCents - refundsCents - feesCents + adjustmentsCents;
  const differenceCents = payout.netCents - expectedCents;

  const all = [...sales, ...refunds];
  const byScenarioMap = new Map<ScenarioCode, ScenarioTotal>();
  for (const l of all) {
    const t = byScenarioMap.get(l.scenario) ?? {
      code: l.scenario,
      name: SCENARIOS[l.scenario].name,
      count: 0,
      grossCents: 0,
      gstCents: 0,
    };
    t.count++;
    t.grossCents += l.grossCents;
    t.gstCents += l.gstCents;
    byScenarioMap.set(l.scenario, t);
  }

  const reviewCount = all.filter((l) => l.approval === "review").length;
  const status: ReportStatus = differenceCents !== 0 ? "unbalanced" : reviewCount > 0 ? "needs_review" : "ready";

  return {
    channel: payout.channel,
    payoutId: payout.payoutId,
    payoutDate: payout.payoutDate,
    netCents: payout.netCents,
    expectedCents,
    differenceCents,
    status,
    sales,
    refunds,
    fees,
    adjustments: payout.adjustments,
    totals: {
      salesGrossCents,
      refundsCents,
      feesCents,
      adjustmentsCents,
      gstCents: all.reduce((a, l) => a + l.gstCents, 0),
      notionalItcCents: all.reduce((a, l) => a + l.notionalItcCents, 0),
      byScenario: [...byScenarioMap.values()].sort((a, b) => a.code.localeCompare(b.code)),
    },
    saleCount: payout.sales.length,
    reviewCount,
    warnings,
    generatedAt: now.toISOString(),
  };
}
