/**
 * In-memory store for LessonRevision records. A plain class with no global state and no database handle.
 *
 * - Input is LessonRevision[] from the caller (the ingest loader). This module does not import the loader.
 * - Pins are data: a map from revision id to CourseRef[], not a join on the Desk database.
 * - Status is enforced on every read. PUBLISHED is always readable. DRAFT is readable only when the caller
 *   passes allowDraftRevisions: true (the internal draft option). REVIEW, RETIRED and any other status are never
 *   returned.
 * - Reads return copies, so a caller cannot change stored state through a returned object.
 */
import type { CourseRef, LessonRevision } from '../knowledge/types.ts';

export interface RevisionReadOptions {
  /** Internal draft option. Only pass true when internalDraftAccessEnabled() is true. */
  allowDraftRevisions?: boolean;
}

export interface RevisionPinReadOptions extends RevisionReadOptions {
  /** Restrict to pins in this vertical. */
  verticalId?: string;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

export class CourseRevisionConflictError extends Error {
  readonly code = 'revision_conflict';
  constructor(message: string) {
    super(message);
    this.name = 'CourseRevisionConflictError';
  }
}

interface StoredRevision {
  lessonId: string;
  status: string;
  contentHash: string;
  body: unknown;
  pins: CourseRef[];
}

const pairKey = (lessonId: string, contentHash: string): string => `${lessonId}\u0000${contentHash}`;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * Same rule as the search port's KB_ID. A revision id outside it would be silently dropped
 * at search time, so the store refuses it here instead.
 */
export const REVISION_ID_RULE = /^[A-Za-z0-9_-]{1,100}$/;

function assertWellFormed(revision: LessonRevision): void {
  if (!isNonEmptyString(revision?.id)) throw new TypeError('revision.id is required');
  if (!REVISION_ID_RULE.test(revision.id)) {
    throw new TypeError(`revision id "${revision.id}" must match ${REVISION_ID_RULE} (letters, digits, underscore, hyphen)`);
  }
  if (!isNonEmptyString(revision.lessonId)) throw new TypeError(`revision ${revision.id}: lessonId is required`);
  if (!isNonEmptyString(revision.status)) throw new TypeError(`revision ${revision.id}: status is required`);
  if (!isNonEmptyString(revision.contentHash)) throw new TypeError(`revision ${revision.id}: contentHash is required`);
  if (!Array.isArray(revision.courses)) throw new TypeError(`revision ${revision.id}: courses must be an array`);
  for (const pin of revision.courses) {
    if (!isNonEmptyString(pin?.courseId) || !isNonEmptyString(pin.verticalId)) {
      throw new TypeError(`revision ${revision.id}: every course pin needs courseId and verticalId`);
    }
  }
}

const pinsOf = (revision: LessonRevision): CourseRef[] =>
  revision.courses.map((c) => ({ courseId: c.courseId, verticalId: c.verticalId }));

/** Compares everything a revision carries. Used for duplicate ids inside one batch. */
function sameRevision(a: LessonRevision, b: LessonRevision): boolean {
  return a.lessonId === b.lessonId
    && a.status === b.status
    && a.contentHash === b.contentHash
    && JSON.stringify(pinsOf(a)) === JSON.stringify(pinsOf(b))
    && JSON.stringify(a.body) === JSON.stringify(b.body);
}

export class CourseRevisionStore {
  private readonly records = new Map<string, StoredRevision>();

  /**
   * Inserts or updates revisions by id. Idempotent: the same input twice gives unchanged counts the second time.
   * Rejects, before writing anything, when:
   * - two different ids share a lessonId and contentHash (a second revision of the same content);
   * - an existing id is sent with a different lessonId or contentHash (content is fixed per id);
   * - one batch names the same id twice with different data.
   * A status change on the same id and content (for example DRAFT to PUBLISHED) is an update.
   */
  upsert(revisions: readonly LessonRevision[]): UpsertResult {
    const plan = new Map<string, LessonRevision>();
    for (const revision of revisions) {
      assertWellFormed(revision);
      const planned = plan.get(revision.id);
      if (planned !== undefined && !sameRevision(planned, revision)) {
        throw new CourseRevisionConflictError(`revision ${revision.id} appears twice in one batch with different data`);
      }
      plan.set(revision.id, revision);
    }

    const pairOwner = new Map<string, string>();
    for (const [id, stored] of this.records) pairOwner.set(pairKey(stored.lessonId, stored.contentHash), id);

    for (const revision of plan.values()) {
      const existing = this.records.get(revision.id);
      if (existing && (existing.lessonId !== revision.lessonId || existing.contentHash !== revision.contentHash)) {
        throw new CourseRevisionConflictError(`revision ${revision.id} already exists with a different lesson or content hash`);
      }
      const key = pairKey(revision.lessonId, revision.contentHash);
      const owner = pairOwner.get(key);
      if (owner !== undefined && owner !== revision.id) {
        throw new CourseRevisionConflictError(
          `lesson ${revision.lessonId} already has revision ${owner} with this content hash; ${revision.id} conflicts`,
        );
      }
      pairOwner.set(key, revision.id);
    }

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const revision of plan.values()) {
      const existing = this.records.get(revision.id);
      const next: StoredRevision = {
        lessonId: revision.lessonId,
        status: revision.status,
        contentHash: revision.contentHash,
        body: structuredClone(revision.body),
        pins: pinsOf(revision),
      };
      if (!existing) {
        inserted += 1;
      } else if (existing.status === next.status
        && JSON.stringify(existing.pins) === JSON.stringify(next.pins)
        && JSON.stringify(existing.body) === JSON.stringify(next.body)) {
        unchanged += 1;
      } else {
        updated += 1;
      }
      this.records.set(revision.id, next);
    }
    return { inserted, updated, unchanged };
  }

  /** Revisions of one lesson that the caller may read. Insertion order. */
  listByLesson(lessonId: string, options: RevisionReadOptions = {}): LessonRevision[] {
    const out: LessonRevision[] = [];
    for (const [id, stored] of this.records) {
      if (stored.lessonId === lessonId && isReadable(stored.status, options)) out.push(this.toRevision(id, stored));
    }
    return out;
  }

  /** Revisions pinned to a course that the caller may read, optionally limited to one vertical. Insertion order. */
  listPinnedToCourse(courseId: string, options: RevisionPinReadOptions = {}): LessonRevision[] {
    const out: LessonRevision[] = [];
    for (const [id, stored] of this.records) {
      if (!isReadable(stored.status, options)) continue;
      const pinned = stored.pins.some((p) => p.courseId === courseId
        && (options.verticalId === undefined || p.verticalId === options.verticalId));
      if (pinned) out.push(this.toRevision(id, stored));
    }
    return out;
  }

  private toRevision(id: string, stored: StoredRevision): LessonRevision {
    return {
      id,
      lessonId: stored.lessonId,
      status: stored.status,
      contentHash: stored.contentHash,
      courses: stored.pins.map((p) => ({ ...p })),
      body: structuredClone(stored.body),
    };
  }
}

/** PUBLISHED is always readable. DRAFT only with the internal draft option. Every other status never. */
function isReadable(status: string, options: RevisionReadOptions): boolean {
  if (status === 'PUBLISHED') return true;
  return status === 'DRAFT' && options.allowDraftRevisions === true;
}
