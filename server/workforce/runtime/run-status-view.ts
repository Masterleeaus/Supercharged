/**
 * User-facing view of a run's status. Maps the internal run status (see ./run.ts) to one of seven labels a
 * user can read, with plain English text and an optional detail line. Pure: no database, no clock of its
 * own (the caller passes `now`), and no internal names in any output string.
 *
 * Mapping:
 *   queued              -> queued
 *   running             -> running
 *   awaiting_approval   -> awaiting_approval (needs_attention when the wait is older than staleAfterMs,
 *                          or when no approval is recorded, or when the timestamp cannot be read)
 *   completed           -> completed
 *   failed              -> failed
 *   cancelled           -> cancelled
 *   budget_exhausted    -> needs_attention (the run stopped on its budget; someone must decide what next)
 *   any other value     -> needs_attention (fail visible, not silent)
 */
import type { RunRecord } from './run.ts';

export const RUN_VIEW_LABELS = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'needs_attention',
] as const;
export type RunViewLabel = (typeof RUN_VIEW_LABELS)[number];

export interface RunStatusViewOptions {
  /** Milliseconds an approval may wait before the run is shown as needing attention. Unset means never stale. */
  staleAfterMs?: number;
}

export interface RunStatusView {
  label: RunViewLabel;
  text: string;
  detail: string | null;
}

export type RunStatusInput = Pick<RunRecord, 'status' | 'updatedAt' | 'pendingApproval'>;

const LABEL_TEXT: Readonly<Record<RunViewLabel, string>> = {
  queued: 'Waiting to start',
  running: 'In progress',
  awaiting_approval: 'Waiting for your approval',
  completed: 'Finished',
  failed: 'Stopped because of an error',
  cancelled: 'Stopped at your request',
  needs_attention: 'Needs your attention',
};

/** Plain English text for a user-facing label. */
export function runStatusText(label: RunViewLabel): string {
  return LABEL_TEXT[label];
}

export function runStatusView(run: RunStatusInput, now: Date, options: RunStatusViewOptions = {}): RunStatusView {
  switch (run.status) {
    case 'queued':
      return view('queued', null);
    case 'running':
      return view('running', null);
    case 'completed':
      return view('completed', null);
    case 'failed':
      return view('failed', null);
    case 'cancelled':
      return view('cancelled', null);
    case 'budget_exhausted':
      return view('needs_attention', 'The run used up its budget before it finished.');
    case 'awaiting_approval':
      return awaitingApproval(run, now, options);
    default:
      return view('needs_attention', 'The run is in a state this view does not recognise.');
  }
}

function awaitingApproval(run: RunStatusInput, now: Date, options: RunStatusViewOptions): RunStatusView {
  if (run.pendingApproval === null || run.pendingApproval === undefined) {
    return view('needs_attention', 'The run is paused but no approval request is on record.');
  }
  const since = Date.parse(run.updatedAt);
  const nowMs = now.getTime();
  if (Number.isNaN(since) || Number.isNaN(nowMs)) {
    return view('needs_attention', 'The time the run started waiting cannot be read.');
  }
  if (options.staleAfterMs !== undefined && nowMs - since > options.staleAfterMs) {
    return view('needs_attention', `No decision has been made since ${run.updatedAt}.`);
  }
  return view('awaiting_approval', `Waiting since ${run.updatedAt}.`);
}

function view(label: RunViewLabel, detail: string | null): RunStatusView {
  return { label, text: LABEL_TEXT[label], detail };
}
