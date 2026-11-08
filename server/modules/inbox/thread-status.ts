/*
 * Thread status transitions for the shared inbox: open, snoozed, closed. Pure
 * functions. The caller supplies `now`, nothing reads the clock, and nothing is
 * mutated: every successful transition returns a new thread object.
 */
import type { Thread, ThreadStatus } from './types.ts';

/** Why a transition happened. Recorded in statusHistory. */
export const TRANSITION_REASONS = ['manual', 'inbound', 'snooze_expired'] as const;
export type TransitionReason = (typeof TRANSITION_REASONS)[number];

/** Actor recorded for automatic wake-ups. Not an agent id, so not subject to agent rules. */
export const SYSTEM_ACTOR_ID = 'system:auto-wake';

export interface StatusChange {
  from: ThreadStatus;
  to: ThreadStatus;
  actorId: string;
  at: Date;
  reason: TransitionReason;
}

/** A thread with the snooze deadline and the transition log this module needs. */
export type StatusThread = Thread & {
  snoozeUntil: Date | null;
  statusHistory: readonly StatusChange[];
};

export type TransitionFailure =
  | 'invalid_actor'
  | 'invalid_transition'
  | 'invalid_snooze'
  | 'human_only';

export interface TransitionInput {
  thread: StatusThread;
  to: ThreadStatus;
  actorId: string;
  now: Date;
  /** Required when `to` is 'snoozed'. Must be later than `now`. */
  snoozeUntil?: Date | null;
  /** Defaults to 'manual'. */
  reason?: TransitionReason;
}

export type TransitionResult =
  | { ok: true; thread: StatusThread }
  | { ok: false; reason: TransitionFailure };

/** Allowed (from -> to) pairs. Any pair not listed is refused as invalid_transition. */
const ALLOWED: Readonly<Record<ThreadStatus, readonly ThreadStatus[]>> = {
  open: ['snoozed', 'closed'],
  snoozed: ['open', 'closed'],
  closed: ['open'],
};

/**
 * Agent actors are 'agent:<id>'. The check ignores case and surrounding whitespace so
 * 'Agent:x' or ' agent:x' cannot bypass the human-only rules. Non-strings are not agents.
 */
export function isAgentActor(actorId: string): boolean {
  return typeof actorId === 'string' && actorId.trim().toLowerCase().startsWith('agent:');
}

/**
 * An agent may reopen or wake a thread only when the reason is inbound (a new
 * message arrived), or when a snoozed thread's snooze has expired. Humans may do either.
 */
function agentMayOpen(from: ThreadStatus, reason: TransitionReason): boolean {
  if (reason === 'inbound') return true;
  return from === 'snoozed' && reason === 'snooze_expired';
}

export function transitionThread(input: TransitionInput): TransitionResult {
  const { thread, to, actorId, now, snoozeUntil = null, reason = 'manual' } = input;

  if (typeof actorId !== 'string' || actorId.trim().length === 0) {
    return { ok: false, reason: 'invalid_actor' };
  }

  const from = thread.status;
  if (!ALLOWED[from].includes(to)) {
    return { ok: false, reason: 'invalid_transition' };
  }

  const agent = isAgentActor(actorId);
  if (to === 'closed' || to === 'snoozed') {
    if (agent) return { ok: false, reason: 'human_only' };
  }
  if (to === 'open' && agent && !agentMayOpen(from, reason)) {
    return { ok: false, reason: 'human_only' };
  }
  if (to === 'snoozed') {
    if (!(snoozeUntil instanceof Date) || !(snoozeUntil.getTime() > now.getTime())) {
      return { ok: false, reason: 'invalid_snooze' };
    }
  }

  const entry: StatusChange = {
    from,
    to,
    actorId,
    at: new Date(now.getTime()),
    reason,
  };

  return {
    ok: true,
    thread: {
      ...thread,
      status: to,
      snoozeUntil: to === 'snoozed' && snoozeUntil instanceof Date ? new Date(snoozeUntil.getTime()) : null,
      updatedAt: new Date(now.getTime()),
      statusHistory: [...thread.statusHistory, entry],
    },
  };
}

/**
 * Wakes a snoozed thread whose snoozeUntil has passed (at or before `now`).
 * Any other thread is returned as the same object, unchanged.
 */
export function autoWake(thread: StatusThread, now: Date): StatusThread {
  if (thread.status !== 'snoozed' || thread.snoozeUntil === null) return thread;
  if (thread.snoozeUntil.getTime() > now.getTime()) return thread;

  return {
    ...thread,
    status: 'open',
    snoozeUntil: null,
    updatedAt: new Date(now.getTime()),
    statusHistory: [
      ...thread.statusHistory,
      {
        from: 'snoozed',
        to: 'open',
        actorId: SYSTEM_ACTOR_ID,
        at: new Date(now.getTime()),
        reason: 'snooze_expired',
      },
    ],
  };
}
