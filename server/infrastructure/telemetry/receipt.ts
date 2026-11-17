/**
 * Usage receipts for metering. Built from a run's recorded spans, one row per company id.
 * Each row holds only counts and the company id. No personal data is included.
 */

import { AGENT_RUN_SPAN, TOOL_CALL_SPAN } from './spans.ts';
import type { TelemetryAttributes } from './redact.ts';

export interface RecordedSpan {
  name: string;
  attributes: TelemetryAttributes;
}

export interface UsageReceiptRow {
  companyId: string;
  runs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const COMPANY_KEY = 'titan.company_id';
const INPUT_KEY = 'gen_ai.usage.input_tokens';
const OUTPUT_KEY = 'gen_ai.usage.output_tokens';

const numberOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Counts runs, tool calls and tokens per company id.
 * Spans with no company id are skipped. Rows are sorted by company id.
 */
export const buildUsageReceipt = (spans: readonly RecordedSpan[]): UsageReceiptRow[] => {
  const rows = new Map<string, UsageReceiptRow>();

  for (const span of spans) {
    const companyId = span.attributes[COMPANY_KEY];
    if (typeof companyId !== 'string' || companyId.length === 0) {
      continue;
    }
    if (span.name !== AGENT_RUN_SPAN && span.name !== TOOL_CALL_SPAN) {
      continue;
    }

    let row = rows.get(companyId);
    if (!row) {
      row = { companyId, runs: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      rows.set(companyId, row);
    }

    if (span.name === AGENT_RUN_SPAN) {
      row.runs += 1;
      row.inputTokens += numberOf(span.attributes[INPUT_KEY]);
      row.outputTokens += numberOf(span.attributes[OUTPUT_KEY]);
      row.totalTokens = row.inputTokens + row.outputTokens;
    } else {
      row.toolCalls += 1;
    }
  }

  return [...rows.values()].sort((a, b) => (a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0));
};
