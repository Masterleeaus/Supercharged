/**
 * Settlement arithmetic. Port of SettlementReconciliation.php, with the report added.
 * Every amount is an integer in minor units. Each expected line is signed, so the expected lines sum to the
 * expected net. The report checks that invariant when it is built.
 */
import { OrderOpsError } from "./types.ts";
import type { SettlementReport, SettlementReportLine } from "./types.ts";

export interface SettlementInputEntry {
  type: string;
  amount: number;
}

export interface SettlementCalculation {
  grossAmount: number;
  feeAmount: number;
  taxWithheldAmount: number;
  shippingCostAmount: number;
  refundAmount: number;
  chargebackAmount: number;
  adjustmentAmount: number;
  expectedNetAmount: number;
  reportedNetAmount: number;
  varianceAmount: number;
  status: "awaiting_payout" | "reconciled" | "variance";
}

type Bucket = "gross" | "fee" | "tax" | "shipping" | "refund" | "chargeback" | "payout" | "adjustment";

const BUCKETS: Record<string, Bucket> = {
  sale: "gross", gross: "gross", order: "gross",
  fee: "fee", fees: "fee", commission: "fee", processing_fee: "fee",
  tax: "tax", withheld_tax: "tax",
  shipping_cost: "shipping", shipping_fee: "shipping", postage: "shipping",
  refund: "refund", refunded: "refund",
  chargeback: "chargeback", dispute: "chargeback",
  payout: "payout", net_payout: "payout", deposit: "payout",
};

const LABELS: Record<Bucket, string> = {
  gross: "Sale", fee: "Marketplace or processing fee", tax: "Tax withheld", shipping: "Shipping cost",
  refund: "Refund", chargeback: "Chargeback or dispute", payout: "Payout received", adjustment: "Adjustment",
};

function bucketOf(type: string): Bucket {
  return BUCKETS[type.trim().toLowerCase()] ?? "adjustment";
}

/** Totals by bucket. Fee, tax, shipping, refund and chargeback amounts are taken as absolute values. */
export function calculateSettlement(entries: SettlementInputEntry[]): SettlementCalculation {
  const totals = { gross: 0, fee: 0, tax: 0, shipping: 0, refund: 0, chargeback: 0, payout: 0, adjustment: 0 };
  for (const entry of entries) {
    const bucket = bucketOf(entry.type);
    const amount = entry.amount;
    if (bucket === "gross" || bucket === "payout" || bucket === "adjustment") totals[bucket] += amount;
    else totals[bucket] += Math.abs(amount);
  }
  const expected = totals.gross - totals.fee - totals.tax - totals.shipping - totals.refund - totals.chargeback + totals.adjustment;
  const variance = totals.payout - expected;
  return {
    grossAmount: totals.gross,
    feeAmount: totals.fee,
    taxWithheldAmount: totals.tax,
    shippingCostAmount: totals.shipping,
    refundAmount: totals.refund,
    chargebackAmount: totals.chargeback,
    adjustmentAmount: totals.adjustment,
    expectedNetAmount: expected,
    reportedNetAmount: totals.payout,
    varianceAmount: variance,
    status: totals.payout === 0 ? "awaiting_payout" : variance === 0 ? "reconciled" : "variance",
  };
}

/** Builds the report. Expected lines sum to expectedNetMinor. Reported lines sum to reportedNetMinor. */
export function buildSettlementReport(currency: string, entries: SettlementInputEntry[]): SettlementReport {
  const lines: SettlementReportLine[] = entries.map((entry) => {
    const bucket = bucketOf(entry.type);
    const isExpected = bucket !== "payout";
    const signed = bucket === "gross" || bucket === "adjustment" || bucket === "payout" ? entry.amount : -Math.abs(entry.amount);
    return {
      kind: isExpected ? "expected" : "reported",
      entryType: entry.type,
      label: LABELS[bucket],
      amountMinor: signed,
    };
  });
  const calc = calculateSettlement(entries);
  const expectedNetMinor = lines.filter((l) => l.kind === "expected").reduce((sum, l) => sum + l.amountMinor, 0);
  const reportedNetMinor = lines.filter((l) => l.kind === "reported").reduce((sum, l) => sum + l.amountMinor, 0);
  if (expectedNetMinor !== calc.expectedNetAmount || reportedNetMinor !== calc.reportedNetAmount) {
    throw new OrderOpsError("Settlement report lines do not sum to the calculated totals.", 500);
  }
  return {
    currency,
    lines,
    expectedNetMinor,
    reportedNetMinor,
    varianceMinor: reportedNetMinor - expectedNetMinor,
    status: calc.status,
  };
}
