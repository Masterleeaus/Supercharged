/*
 * Provider-agnostic inbound email parsing. Pure function: no I/O, no store, no clock.
 * Turns a parsed email payload into the shape thread-match's matchThread consumes
 * (channel, fromAddress, inReplyTo, receivedAt in ms). Callers should pass the
 * result's inbound fields through matchThread with their own companyId.
 */

export const MAX_SUBJECT_LENGTH = 300;
export const MAX_BODY_LENGTH = 20000;

export type InboundEmailRefusal =
  | 'invalid_from'
  | 'missing_message_id'
  | 'invalid_date'
  | 'invalid_company';

export interface InboundEmailPayload {
  from: string;
  to?: string | string[];
  subject?: string;
  text?: string;
  messageId: string;
  inReplyTo?: string | string[] | null;
  references?: string | string[] | null;
  date: Date | string | number;
}

export interface InboundEmail {
  channel: 'email';
  fromAddress: string;
  subject: string;
  inReplyTo: string | undefined;
  messageId: string;
  receivedAt: number;
  body: string;
}

export type ParseInboundEmailResult =
  | { ok: true; inbound: InboundEmail }
  | { ok: false; reason: InboundEmailRefusal };

/**
 * Removes quoted reply lines (starting with '>') and everything from a standard
 * '-- ' signature separator onwards. Trailing whitespace on the result is trimmed.
 */
export function stripQuotedText(text: string | null | undefined): string {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '-- ') break;
    if (line.startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trimEnd();
}

/** First non-empty value from a string or list, trimmed. */
function firstValue(value: string | string[] | null | undefined): string | undefined {
  const list = Array.isArray(value) ? value : [value];
  for (const item of list) {
    const trimmed = typeof item === 'string' ? item.trim() : '';
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Last ID of a References header (string split on whitespace, or a list). */
function lastReference(value: string | string[] | null | undefined): string | undefined {
  const ids: string[] = [];
  const list = Array.isArray(value) ? value : [value];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    for (const part of item.split(/\s+/)) {
      if (part) ids.push(part);
    }
  }
  return ids.length > 0 ? ids[ids.length - 1] : undefined;
}

/**
 * Canonical form of a Message-ID for comparison: trimmed, with one pair of angle brackets.
 * The send path stores ids as "<local@domain>", but a provider may return the bare form or
 * add whitespace, so both sides go through this before they are compared. Case is kept.
 */
export function normaliseMessageId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const bare = value.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  return bare ? `<${bare}>` : '';
}

/**
 * Candidate ids to match against stored thread messageIds, most specific first: In-Reply-To,
 * then References from the last entry back to the first. Empty and duplicate ids are dropped.
 */
export function inboundReferenceIds(
  payload: Pick<InboundEmailPayload, 'inReplyTo' | 'references'> | null | undefined,
): string[] {
  const ids: string[] = [];
  const add = (raw: string) => {
    const id = normaliseMessageId(raw);
    if (id && !ids.includes(id)) ids.push(id);
  };
  const inReplyTo = Array.isArray(payload?.inReplyTo) ? payload.inReplyTo : [payload?.inReplyTo];
  for (const item of inReplyTo) if (typeof item === 'string') add(item);

  const refs = Array.isArray(payload?.references) ? payload.references : [payload?.references];
  const refParts: string[] = [];
  for (const item of refs) {
    if (typeof item !== 'string') continue;
    for (const part of item.split(/\s+/)) if (part) refParts.push(part);
  }
  for (let i = refParts.length - 1; i >= 0; i -= 1) add(refParts[i]);
  return ids;
}

function parseReceivedAt(date: unknown): number | undefined {
  if (date === null || date === undefined || date === '') return undefined;
  const ms =
    date instanceof Date
      ? date.getTime()
      : typeof date === 'number' || typeof date === 'string'
        ? new Date(date).getTime()
        : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseInboundEmail(
  payload: InboundEmailPayload,
  { companyId }: { companyId: string },
): ParseInboundEmailResult {
  if (typeof companyId !== 'string' || companyId.trim() === '') {
    return { ok: false, reason: 'invalid_company' };
  }

  const fromRaw = typeof payload?.from === 'string' ? payload.from.trim().toLowerCase() : '';
  if (!fromRaw.includes('@')) {
    return { ok: false, reason: 'invalid_from' };
  }

  const messageId = typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
  if (!messageId) {
    return { ok: false, reason: 'missing_message_id' };
  }

  const receivedAt = parseReceivedAt(payload.date);
  if (receivedAt === undefined) {
    return { ok: false, reason: 'invalid_date' };
  }

  const subject = (typeof payload.subject === 'string' ? payload.subject : '')
    .trim()
    .slice(0, MAX_SUBJECT_LENGTH);

  const inReplyTo = firstValue(payload.inReplyTo) ?? lastReference(payload.references);

  const body = stripQuotedText(payload.text).slice(0, MAX_BODY_LENGTH);

  return {
    ok: true,
    inbound: {
      channel: 'email',
      fromAddress: fromRaw,
      subject,
      inReplyTo,
      messageId,
      receivedAt,
      body,
    },
  };
}
