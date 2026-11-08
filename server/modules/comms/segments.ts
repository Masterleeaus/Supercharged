// Contact segments: pure definitions and evaluation over lifecycle, tags, engagement and consent.
// No database, no network. Time is passed in as `now`, never read from the clock.
// Every rule must match. A contact with a missing field fails that rule (nothing is assumed).

import { CHANNELS, type Channel } from './consent.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SegmentRule =
  | { field: 'tag'; op: 'has'; value: string }
  | { field: 'lifecycle'; op: 'eq'; value: string }
  | { field: 'lastEngagementDays'; op: 'lte' | 'gte'; value: number }
  | { field: 'consent'; op: 'opted_in'; channel: Channel };

export interface SegmentDefinition {
  companyId: string;
  name: string;
  rules: SegmentRule[];
}

export interface Segment extends SegmentDefinition {
  readonly rules: readonly SegmentRule[];
}

export interface SegmentContact {
  id: string;
  companyId: string;
  tags?: string[] | null;
  lifecycle?: string | null;
  lastEngagementAt?: Date | number | string | null;
  consent?: Partial<Record<Channel, boolean>> | null;
}

export type SegmentReason = 'invalid_segment' | 'invalid_company';

export type DefineSegmentResult =
  | { ok: true; segment: Segment }
  | { ok: false; reason: SegmentReason; message: string };

export type DateInput = Date | number | string;

// Segment objects produced by defineSegment. A WeakSet lets evaluateSegment refuse a hand-built object.
const defined = new WeakSet<object>();

function fail(reason: SegmentReason, message: string): { ok: false; reason: SegmentReason; message: string } {
  return { ok: false, reason, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateRule(rule: unknown): string | null {
  if (!rule || typeof rule !== 'object') return 'each rule must be an object';
  const r = rule as Record<string, unknown>;
  switch (r.field) {
    case 'tag':
      if (r.op !== 'has') return `unknown op for tag: ${String(r.op)}`;
      if (!isNonEmptyString(r.value)) return 'tag rule needs a non-empty string value';
      return null;
    case 'lifecycle':
      if (r.op !== 'eq') return `unknown op for lifecycle: ${String(r.op)}`;
      if (!isNonEmptyString(r.value)) return 'lifecycle rule needs a non-empty string value';
      return null;
    case 'lastEngagementDays':
      if (r.op !== 'lte' && r.op !== 'gte') return `unknown op for lastEngagementDays: ${String(r.op)}`;
      if (!isFiniteNumber(r.value) || r.value < 0) return 'lastEngagementDays rule needs a non-negative finite number';
      return null;
    case 'consent':
      if (r.op !== 'opted_in') return `unknown op for consent: ${String(r.op)}`;
      if (!isChannel(r.channel)) return `unknown consent channel: ${String(r.channel)}`;
      return null;
    default:
      return `unknown field: ${String(r.field)}`;
  }
}

/**
 * Validates and freezes a segment definition. Refuses a non-UUID companyId ('invalid_company')
 * and an empty name, an empty rule list, or any unknown field or op ('invalid_segment').
 */
export function defineSegment(input: { companyId: unknown; name: unknown; rules: unknown }): DefineSegmentResult {
  const companyId = input?.companyId;
  if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) {
    return fail('invalid_company', 'companyId must be a UUID');
  }
  if (!isNonEmptyString(input.name)) return fail('invalid_segment', 'name is required');
  if (!Array.isArray(input.rules) || input.rules.length === 0) {
    return fail('invalid_segment', 'a segment needs at least one rule');
  }
  for (const rule of input.rules) {
    const problem = validateRule(rule);
    if (problem) return fail('invalid_segment', problem);
  }
  const segment: Segment = Object.freeze({
    companyId,
    name: input.name,
    rules: Object.freeze(input.rules.map((rule: SegmentRule) => Object.freeze({ ...rule }))),
  }) as Segment;
  defined.add(segment);
  return { ok: true, segment };
}

function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function matchesRule(rule: SegmentRule, contact: SegmentContact, nowMs: number): boolean {
  switch (rule.field) {
    case 'tag':
      return Array.isArray(contact.tags) && contact.tags.includes(rule.value);
    case 'lifecycle':
      return typeof contact.lifecycle === 'string' && contact.lifecycle === rule.value;
    case 'lastEngagementDays': {
      const at = toMillis(contact.lastEngagementAt);
      if (at === null) return false;
      const days = (nowMs - at) / DAY_MS;
      return rule.op === 'lte' ? days <= rule.value : days >= rule.value;
    }
    case 'consent':
      return contact.consent != null && contact.consent[rule.channel] === true;
  }
}

/**
 * Returns the contacts from the same company as the segment that meet every rule.
 * Contacts from other companies, or with malformed data, are left out. An invalid segment
 * or an unreadable `now` returns an empty list.
 */
export function evaluateSegment(
  segment: Segment,
  contacts: readonly SegmentContact[],
  options: { now: DateInput },
): SegmentContact[] {
  if (!segment || typeof segment !== 'object' || !defined.has(segment)) return [];
  const nowMs = toMillis(options?.now);
  if (nowMs === null || !Array.isArray(contacts)) return [];
  return contacts.filter(
    (contact) =>
      !!contact &&
      typeof contact === 'object' &&
      contact.companyId === segment.companyId &&
      segment.rules.every((rule) => matchesRule(rule, contact, nowMs)),
  );
}
