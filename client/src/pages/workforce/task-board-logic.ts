/**
 * Pure helpers for the task board and run history screens. No React, no fetch, no clock.
 *
 * The server sends each run's status as a run-status-view label and its plain English text, so the screens
 * show those strings as they arrive. COLUMN_ORDER lists the labels in board order and mirrors RUN_VIEW_LABELS
 * in server/workforce/runtime/run-status-view.ts (tests/client/task-board-logic.test.mjs checks the two match).
 */

export const COLUMN_ORDER = [
  'needs_attention',
  'awaiting_approval',
  'running',
  'queued',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ColumnLabel = (typeof COLUMN_ORDER)[number];

/** Column headings. These match runStatusText in run-status-view.ts; the logic test checks them. */
export const COLUMN_HEADINGS: Readonly<Record<ColumnLabel, string>> = {
  needs_attention: 'Needs your attention',
  awaiting_approval: 'Waiting for your approval',
  running: 'In progress',
  queued: 'Waiting to start',
  completed: 'Finished',
  failed: 'Stopped because of an error',
  cancelled: 'Stopped at your request',
};

export interface TaskRow {
  runId: string;
  label: string;
  text: string;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEvent {
  action: string;
  createdAt: string;
}

export interface HistoryRun {
  runId: string;
  label: string;
  text: string;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  outcome: { reason: string | null };
  events: HistoryEvent[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const optStr = (value: unknown): string | null => (value === null || value === undefined ? null : str(value));

/** Drops any row whose required fields are not strings. Never guesses a missing value. */
export function parseTaskRows(body: unknown): TaskRow[] {
  if (!isObject(body) || !Array.isArray(body.tasks)) return [];
  const rows: TaskRow[] = [];
  for (const item of body.tasks) {
    if (!isObject(item)) continue;
    const runId = str(item.runId);
    const label = str(item.label);
    const text = str(item.text);
    const createdAt = str(item.createdAt);
    const updatedAt = str(item.updatedAt);
    if (runId === null || label === null || text === null || createdAt === null || updatedAt === null) continue;
    rows.push({ runId, label, text, detail: optStr(item.detail), createdAt, updatedAt });
  }
  return rows;
}

export function parseRunHistory(body: unknown): HistoryRun[] {
  if (!isObject(body) || !Array.isArray(body.runs)) return [];
  const runs: HistoryRun[] = [];
  for (const item of body.runs) {
    if (!isObject(item)) continue;
    const runId = str(item.runId);
    const label = str(item.label);
    const text = str(item.text);
    const createdAt = str(item.createdAt);
    const updatedAt = str(item.updatedAt);
    if (runId === null || label === null || text === null || createdAt === null || updatedAt === null) continue;
    const outcome = isObject(item.outcome) ? optStr(item.outcome.reason) : null;
    const events: HistoryEvent[] = [];
    if (Array.isArray(item.events)) {
      for (const event of item.events) {
        if (!isObject(event)) continue;
        const action = str(event.action);
        const at = str(event.createdAt);
        if (action !== null && at !== null) events.push({ action, createdAt: at });
      }
    }
    runs.push({ runId, label, text, detail: optStr(item.detail), createdAt, updatedAt, outcome: { reason: outcome }, events });
  }
  return runs;
}

/** Groups rows into the board columns in COLUMN_ORDER. Rows with an unknown label go to needs_attention. */
export function groupByColumn(rows: readonly TaskRow[]): Record<ColumnLabel, TaskRow[]> {
  const columns = Object.fromEntries(COLUMN_ORDER.map((label) => [label, [] as TaskRow[]])) as Record<ColumnLabel, TaskRow[]>;
  for (const row of rows) {
    const known = (COLUMN_ORDER as readonly string[]).includes(row.label);
    columns[known ? (row.label as ColumnLabel) : 'needs_attention'].push(row);
  }
  return columns;
}

/** Local time for display. Unreadable input shows as unknown rather than an invalid date. */
export function formatTime(iso: string | null): string {
  if (iso === null) return 'Time unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Time unknown' : date.toLocaleString();
}

/** Action names are stored as kinds such as run.started. Shown with spaces and a capital first letter. */
export function eventLabel(action: string): string {
  const spaced = action.replace(/[._]+/g, ' ').trim();
  return spaced === '' ? 'Event' : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
