/**
 * Company data export for the workforce runtime. A company can export its runs, tool calls, tasks, audit events
 * and budget usage as JSON (full records, one document) or CSV (one file per table).
 *
 * - Every query is made for the company named in the call. The store is scoped by companyId, and each row is
 *   checked against it again before it is written out.
 * - Every export that is returned is first recorded as an audit event of kind 'workforce.export'. If that record
 *   cannot be written, the export throws and no data is returned.
 * - A refused call (unknown company id or unsupported format) records nothing.
 *
 * Tasks: the runtime keeps no separate task record. Each run is the task, so the runs table is the task list.
 * Tool calls: the RunStore holds no tool-call rows, so they are read from the tool.* audit events.
 * Budget usage: read from each run's budget counters.
 *
 * Pure apart from the injected store and audit sink. Time comes from the injected `now`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { tryCompanyId } from '../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../services/ai-runtime/types.ts';
import type { RunRecord } from './run.ts';
import type { AuditEvent, AuditSink, RunStore } from './store.ts';

export const EXPORT_FORMATS = ['json', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_AUDIT_KIND = 'workforce.export' as const;

export type ExportRefusalCode = 'company_unknown' | 'format_unsupported';

export class ExportRefusedError extends Error {
  readonly code: ExportRefusalCode;
  constructor(code: ExportRefusalCode, message: string) {
    super(message);
    this.name = 'ExportRefusedError';
    this.code = code;
  }
}

export interface ExportDeps {
  store: RunStore;
  audit: AuditSink;
  now: () => Date;
}

export interface ExportFile {
  name: string;
  contentType: 'application/json' | 'text/csv';
  body: string;
}

export interface ExportResult {
  companyId: CompanyId;
  format: ExportFormat;
  exportedAt: string;
  files: ExportFile[];
}

const CSV_TABLES = {
  runs: ['id', 'status', 'version', 'created_at', 'updated_at', 'path', 'reason', 'role_version', 'pending_approval_id'],
  tool_calls: ['id', 'run_id', 'kind', 'at', 'data'],
  budget_usage: ['run_id', 'tokens_used', 'tokens_limit', 'tool_calls_used', 'tool_calls_limit'],
  audit_events: ['id', 'run_id', 'kind', 'at', 'data'],
} as const;

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvTable(headers: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
  return lines.join('\n') + '\n';
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Exports one company's data. Throws ExportRefusedError for an unknown company or an unsupported format.
 * Throws if the audit event cannot be recorded, so no unrecorded export is returned.
 */
export async function exportCompanyData(deps: ExportDeps, companyId: unknown, format: unknown): Promise<ExportResult> {
  const scoped = tryCompanyId(companyId);
  if (scoped === null) {
    throw new ExportRefusedError('company_unknown', 'export refused: companyId is not a valid company');
  }
  if (typeof format !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new ExportRefusedError('format_unsupported', `export refused: format must be one of ${EXPORT_FORMATS.join(', ')}`);
  }
  const outFormat = format as ExportFormat;

  const runs = (await deps.store.listRuns(scoped)).filter((r: RunRecord) => r.companyId === scoped);
  const auditEvents = (await deps.store.listAudit(scoped)).filter((e: AuditEvent) => e.companyId === scoped);
  const toolCalls = auditEvents.filter((e) => e.kind.startsWith('tool.'));

  const runRows = runs.map((r) => ({
    id: r.id,
    status: r.status,
    version: r.version,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    path: r.path.join('>'),
    reason: r.reason,
    role_version: r.roleVersion ?? null,
    pending_approval_id: r.pendingApproval?.approvalId ?? null,
  }));
  const budgetRows = runs.map((r) => ({
    run_id: r.id,
    tokens_used: r.budget.tokensUsed,
    tokens_limit: r.budget.maxTokens,
    tool_calls_used: r.budget.toolCalls,
    tool_calls_limit: r.budget.maxToolCalls,
  }));
  const toolCallRows = toolCalls.map((e) => ({ id: e.id, run_id: e.runId, kind: e.kind, at: e.at, data: e.data }));
  const auditRows = auditEvents.map((e) => ({ id: e.id, run_id: e.runId, kind: e.kind, at: e.at, data: e.data }));

  const exportedAt = deps.now().toISOString();
  const files: ExportFile[] = [];
  if (outFormat === 'json') {
    files.push({
      name: 'company-export.json',
      contentType: 'application/json',
      body: JSON.stringify(
        { companyId: scoped, exportedAt, runs, toolCalls, budgetUsage: budgetRows, auditEvents },
        null,
        2,
      ),
    });
  } else {
    const tables: Record<keyof typeof CSV_TABLES, readonly Record<string, unknown>[]> = {
      runs: runRows,
      tool_calls: toolCallRows,
      budget_usage: budgetRows,
      audit_events: auditRows,
    };
    for (const name of Object.keys(CSV_TABLES) as (keyof typeof CSV_TABLES)[]) {
      files.push({ name: `${name}.csv`, contentType: 'text/csv', body: csvTable(CSV_TABLES[name], tables[name]) });
    }
  }

  const contentSha256 = sha256(files.map((f) => `${f.name}\n${f.body}`).join('\n'));
  await deps.audit.record({
    id: randomUUID(),
    companyId: scoped,
    runId: null,
    kind: EXPORT_AUDIT_KIND,
    at: exportedAt,
    data: {
      format: outFormat,
      runCount: runs.length,
      toolCallCount: toolCalls.length,
      budgetRowCount: budgetRows.length,
      auditEventCount: auditEvents.length,
      fileCount: files.length,
      contentSha256,
    },
  });

  return { companyId: scoped, format: outFormat, exportedAt, files };
}
