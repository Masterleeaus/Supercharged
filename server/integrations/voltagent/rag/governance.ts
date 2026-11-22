/**
 * Governance for business knowledge answers (issue #335).
 *
 * Applied to every search hit before it reaches a model or a customer. Rules, in order:
 * 1. Provenance: a hit with no governance record, or one not approved, is dropped ('unapproved').
 * 2. Expiry: a hit whose expiresAt is at or before `now` is dropped ('expired').
 * 3. Stale versions: for one sourceId only the highest approved version is kept ('superseded').
 * 4. Language: hits in the requested language are kept. If none exist, hits in the fallback language are kept
 *    and marked as fallback. If neither exists the answer is unknown.
 * 5. Redaction: emails, card-like numbers and phone-like numbers are replaced in the text returned.
 *
 * When nothing survives, callers must answer with SAFE_UNKNOWN_ANSWER. Nothing is invented.
 * Pure functions: the clock and the languages are passed in.
 *
 * Licence: original TitanZero code.
 */

export const SAFE_UNKNOWN_ANSWER =
  "I don't have approved information to answer that. A team member can help you with it.";

export interface ChunkGovernance {
  sourceId: string;
  version: number;
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  /** ISO timestamp. Null means the document does not expire. */
  expiresAt: string | null;
  /** BCP-47 style language tag such as 'en' or 'en-GB'. */
  language: string;
}

export interface GovernableHit {
  knowledgeBaseId: string;
  chunkIndex: number;
  chunkText: string;
  score: number;
  governance?: ChunkGovernance | null;
}

export type DropReason = 'unapproved' | 'expired' | 'superseded' | 'language_unavailable';

export interface GovernanceOptions {
  now: Date;
  language: string;
  fallbackLanguage?: string;
}

export type GovernedHit<T extends GovernableHit = GovernableHit> = T & { fallbackLanguage: boolean };

export interface GovernanceOutcome<T extends GovernableHit = GovernableHit> {
  kept: GovernedHit<T>[];
  dropped: Record<DropReason, number>;
  unknown: boolean;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)/g;

/** Replaces emails, card-like and phone-like numbers. Short numbers such as prices are left alone. */
export function redactText(text: string): string {
  return text
    .replace(EMAIL, '[redacted-email]')
    .replace(CARD, (m) => (m.replace(/\D/g, '').length >= 13 ? '[redacted-card]' : m))
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? '[redacted-phone]' : m));
}

const sameLanguage = (a: string, b: string): boolean => a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();

const isExpired = (expiresAt: string | null, now: Date): boolean => {
  if (expiresAt === null) return false;
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? true : t <= now.getTime();
};

/** Applies the governance rules. Fails closed: an unreadable expiry counts as expired. */
export function governChunks<T extends GovernableHit>(hits: readonly T[], options: GovernanceOptions): GovernanceOutcome<T> {
  const dropped: Record<DropReason, number> = { unapproved: 0, expired: 0, superseded: 0, language_unavailable: 0 };

  const approved: T[] = [];
  for (const hit of hits) {
    const g = hit.governance;
    if (!g || g.approved !== true || !g.approvedBy || !g.approvedAt) {
      dropped.unapproved += 1;
    } else if (isExpired(g.expiresAt, options.now)) {
      dropped.expired += 1;
    } else {
      approved.push(hit);
    }
  }

  // Keep only the highest version of each source.
  const latest = new Map<string, number>();
  for (const hit of approved) {
    const g = hit.governance as ChunkGovernance;
    latest.set(g.sourceId, Math.max(latest.get(g.sourceId) ?? 0, g.version));
  }
  const current: T[] = [];
  for (const hit of approved) {
    const g = hit.governance as ChunkGovernance;
    if (g.version === latest.get(g.sourceId)) current.push(hit);
    else dropped.superseded += 1;
  }

  const requested = current.filter((h) => sameLanguage((h.governance as ChunkGovernance).language, options.language));
  let picked: GovernedHit<T>[] = requested.map((h) => ({ ...h, fallbackLanguage: false }));
  if (picked.length === 0 && options.fallbackLanguage) {
    const fallback = current.filter((h) => sameLanguage((h.governance as ChunkGovernance).language, options.fallbackLanguage as string));
    picked = fallback.map((h) => ({ ...h, fallbackLanguage: true }));
  }
  dropped.language_unavailable = current.length - picked.length;

  const kept: GovernedHit<T>[] = picked.map((h) => ({ ...h, chunkText: redactText(h.chunkText) }));
  return { kept, dropped, unknown: kept.length === 0 };
}
