// Merges two duplicate contacts of one company into a single record. Pure functions: no store,
// no network. Inputs are never mutated. Email and phone normalisation is not applied here: values
// are carried over as given, and only empty values fall back to the duplicate.

export interface ConsentEntry {
  channel: string;
  granted: boolean;
  /** ISO 8601 timestamp of the consent decision. */
  at: string;
  source: string;
}

export interface MergeableContact {
  id: string;
  companyId: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  tags: string[];
  consent: ConsentEntry[];
}

export interface MergeContactsInput {
  companyId: string;
  primary: MergeableContact;
  duplicate: MergeableContact;
  actorId: string;
  /** ISO 8601 timestamp recorded on the audit entry. */
  now: string;
}

export interface MergedContact {
  id: string;
  companyId: string;
  email: string | null | undefined;
  phone: string | null | undefined;
  name: string | null | undefined;
  tags: string[];
  /**
   * Every consent entry from both contacts. History is never dropped. Each channel that either
   * contact opted out of also gets a system opt-out entry, so the opt-out survives a later opt-in.
   */
  consent: ConsentEntry[];
}

export interface MergeAudit {
  action: 'contacts_merged';
  primaryId: string;
  duplicateId: string;
  actorId: string;
  at: string;
}

export type MergeFailureReason =
  | 'invalid_company'
  | 'human_only'
  | 'cross_company'
  | 'same_contact';

export type MergeContactsResult =
  | { ok: true; merged: MergedContact; audit: MergeAudit }
  | { ok: false; reason: MergeFailureReason };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isEmpty(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

function time(iso: string): number {
  return Date.parse(iso);
}

/**
 * Effective consent per channel. An opt-out (granted false) from any entry in any source wins.
 * Otherwise the most recent entry by `at` decides. On equal timestamps the later entry in the
 * list is taken, so the result does not depend on the order in which contacts are merged.
 */
export function effectiveConsent(entries: ReadonlyArray<ConsentEntry>): Record<string, boolean> {
  const latest = new Map<string, ConsentEntry>();
  const optedOut = new Set<string>();
  for (const entry of entries) {
    if (!entry.granted) optedOut.add(entry.channel);
    const current = latest.get(entry.channel);
    if (!current || time(entry.at) >= time(current.at)) latest.set(entry.channel, entry);
  }
  const out: Record<string, boolean> = {};
  for (const [channel, entry] of latest) {
    out[channel] = optedOut.has(channel) ? false : entry.granted;
  }
  return out;
}

/**
 * Merges `duplicate` into `primary`. The merged record keeps primary's id.
 * Refused cases: invalid company id, a non-human actor, a contact from another company, and
 * the same contact passed twice.
 */
export function mergeContacts(input: MergeContactsInput): MergeContactsResult {
  const { companyId, primary, duplicate, actorId, now } = input;

  if (typeof companyId !== 'string' || !UUID.test(companyId)) {
    return { ok: false, reason: 'invalid_company' };
  }
  if (typeof actorId !== 'string' || actorId.length === 0 || actorId.startsWith('agent:')) {
    return { ok: false, reason: 'human_only' };
  }
  if (primary.companyId !== companyId || duplicate.companyId !== companyId) {
    return { ok: false, reason: 'cross_company' };
  }
  if (primary.id === duplicate.id) {
    return { ok: false, reason: 'same_contact' };
  }

  const tags: string[] = [];
  for (const tag of [...primary.tags, ...duplicate.tags]) {
    if (!tags.includes(tag)) tags.push(tag);
  }

  const consent = [...primary.consent, ...duplicate.consent].map((e) => ({ ...e }));

  // An opt-out is permanent across a merge. A later opt-in on the same channel must not revive
  // it, so every opted-out channel gets a system opt-out stamped with the newest entry time.
  // Equal timestamps do not reinstate in checkConsent, so the opt-out wins on that tie too.
  const effective = effectiveConsent(consent);
  let newest: string | undefined;
  for (const entry of consent) {
    if (!Number.isFinite(time(entry.at))) continue;
    if (newest === undefined || time(entry.at) > time(newest)) newest = entry.at;
  }
  if (newest !== undefined) {
    for (const [channel, allowed] of Object.entries(effective)) {
      if (allowed === false) {
        consent.push({ channel, granted: false, at: newest, source: 'system' });
      }
    }
  }

  const merged: MergedContact = {
    id: primary.id,
    companyId,
    email: isEmpty(primary.email) ? duplicate.email : primary.email,
    phone: isEmpty(primary.phone) ? duplicate.phone : primary.phone,
    name: primary.name,
    tags,
    consent,
  };

  const audit: MergeAudit = {
    action: 'contacts_merged',
    primaryId: primary.id,
    duplicateId: duplicate.id,
    actorId,
    at: now,
  };

  return { ok: true, merged, audit };
}
