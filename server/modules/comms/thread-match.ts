/*
 * Thread matching for inbound messages. Pure function: no I/O, no store, no clock
 * other than the receivedAt the caller passes in. Candidates are restricted to the
 * same company and the same channel, so a match never crosses either boundary.
 *
 * Rules, first hit wins:
 *   1. providerThreadId equal.
 *   2. inReplyTo appears in the thread's messageIds.
 *   3. fromAddress equals participantAddress (case-insensitive, trimmed) and the
 *      thread's last message is within 30 days of receivedAt.
 *   4. otherwise { matched: false, reason: 'new_thread' }.
 */
import type { Channel } from '../inbox/types.ts';

export const MATCH_WINDOW_DAYS = 30;
const MATCH_WINDOW_MS = MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type MatchRule = 'provider_thread' | 'in_reply_to' | 'participant_recent';

export interface InboundForMatch {
  companyId: string;
  channel: Channel;
  fromAddress: string;
  subject?: string;
  inReplyTo?: string | null;
  providerThreadId?: string | null;
  receivedAt: Date;
}

export interface ThreadForMatch {
  id: string;
  companyId: string;
  channel: Channel;
  participantAddress: string | null;
  providerThreadId?: string | null;
  messageIds: string[];
  lastMessageAt: Date;
}

export type MatchResult =
  | { matched: true; threadId: string; rule: MatchRule }
  | { matched: false; reason: 'new_thread' };

export interface MatchThreadInput {
  inbound: InboundForMatch;
  threads: ThreadForMatch[];
}

/** Lowercase and trim. Nothing else is stripped, including for email. */
export function normaliseAddress(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normaliseId(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** Latest lastMessageAt wins; ties keep list order. */
function pickLatest(candidates: ThreadForMatch[]): ThreadForMatch | undefined {
  let best: ThreadForMatch | undefined;
  for (const thread of candidates) {
    if (!best || thread.lastMessageAt.getTime() > best.lastMessageAt.getTime()) {
      best = thread;
    }
  }
  return best;
}

export function matchThread({ inbound, threads }: MatchThreadInput): MatchResult {
  const scoped = threads.filter(
    (t) => t.companyId === inbound.companyId && t.channel === inbound.channel,
  );

  const providerThreadId = normaliseId(inbound.providerThreadId);
  if (providerThreadId) {
    const hit = pickLatest(
      scoped.filter((t) => normaliseId(t.providerThreadId) === providerThreadId),
    );
    if (hit) return { matched: true, threadId: hit.id, rule: 'provider_thread' };
  }

  const inReplyTo = normaliseId(inbound.inReplyTo);
  if (inReplyTo) {
    const hit = pickLatest(
      scoped.filter((t) => t.messageIds.some((id) => normaliseId(id) === inReplyTo)),
    );
    if (hit) return { matched: true, threadId: hit.id, rule: 'in_reply_to' };
  }

  const fromAddress = normaliseAddress(inbound.fromAddress);
  const receivedMs = inbound.receivedAt.getTime();
  if (fromAddress) {
    const hit = pickLatest(
      scoped.filter(
        (t) =>
          normaliseAddress(t.participantAddress) === fromAddress &&
          Math.abs(receivedMs - t.lastMessageAt.getTime()) <= MATCH_WINDOW_MS,
      ),
    );
    if (hit) return { matched: true, threadId: hit.id, rule: 'participant_recent' };
  }

  return { matched: false, reason: 'new_thread' };
}

export interface MatchEmailThreadInput {
  companyId: string;
  inbound: { fromAddress: string; receivedAt: Date };
  /** Candidate Message-IDs from inboundReferenceIds(), most specific first. */
  referenceIds: readonly string[];
  threads: ThreadForMatch[];
}

/**
 * Email threading. Message-IDs are compared in their canonical form (see normaliseMessageId in
 * email-inbound.ts), so a bare id and a bracketed id match. Each reference id is tried on its own
 * against rule 2 only, so an older ancestor can never lose to the participant rule. Rule 3 runs
 * last, on the full inbound. Still scoped to the company and to the email channel.
 */
export function matchEmailThread({ companyId, inbound, referenceIds, threads }: MatchEmailThreadInput): MatchResult {
  const canonical: ThreadForMatch[] = threads.map((t) => ({
    ...t,
    messageIds: t.messageIds.map(normaliseMessageIdForMatch),
  }));

  for (const id of referenceIds) {
    const canonicalId = normaliseMessageIdForMatch(id);
    if (!canonicalId) continue;
    const result = matchThread({
      inbound: {
        companyId,
        channel: 'email',
        fromAddress: '',
        inReplyTo: canonicalId,
        providerThreadId: null,
        receivedAt: inbound.receivedAt,
      },
      threads: canonical,
    });
    if (result.matched) return result;
  }

  return matchThread({
    inbound: {
      companyId,
      channel: 'email',
      fromAddress: inbound.fromAddress,
      inReplyTo: null,
      providerThreadId: null,
      receivedAt: inbound.receivedAt,
    },
    threads: canonical,
  });
}

// Same canonical form as normaliseMessageId in email-inbound.ts, kept local so this module
// does not import the parser.
function normaliseMessageIdForMatch(value: string | null | undefined): string {
  const bare = (value ?? '').trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  return bare ? `<${bare}>` : '';
}
