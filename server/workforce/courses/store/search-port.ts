/**
 * KnowledgeSearchPort over the course revision store. Keyword search on the stripped body text of revisions the
 * learner may read. Every rule is re-checked here, and retrieveCompanyKnowledge re-checks the company on each hit.
 *
 * Order for each request:
 * 1. companyId and userId are required (rejected, not returned as empty).
 * 2. getLearnerContext must return a context for the same company and learner.
 * 3. Candidates come only from revisions pinned to the learner's ACTIVE courses in the role's vertical.
 * 4. Each candidate passes canRetrieve (publication, vertical, ACTIVE enrolment for this company), the tier unlock,
 *    and answer-material screening on each text leaf.
 * 5. Keyword matching runs on the stripped body. Only matches are kept.
 * 6. The limit is applied after all filtering.
 */
import { tryCompanyId } from '../../../services/ai-runtime/company.ts';
import type { KnowledgeChunkHit, KnowledgeSearchPort } from '../../runtime/knowledge-retrieval.ts';
import { MAX_RESULTS_CAP, DEFAULT_MAX_RESULTS } from '../../runtime/knowledge-retrieval.ts';
import {
  answerMaterial,
  canRetrieve,
  guardAssessmentPage,
  internalDraftAccessEnabled,
  screenPassageText,
  stripAssessmentData,
  unlockedLessonIds,
} from '../knowledge/policy.ts';
import { MAX_PASSAGE_CHARS, type LearnerContext, type LessonRevision } from '../knowledge/types.ts';
import type { RevisionPinReadOptions } from './revision-store.ts';

export type CourseKnowledgeScopeCode = 'company_required' | 'user_required';

export class CourseKnowledgeScopeError extends Error {
  readonly code: CourseKnowledgeScopeCode;
  constructor(code: CourseKnowledgeScopeCode) {
    super(code === 'company_required' ? 'companyId is required' : 'userId is required');
    this.name = 'CourseKnowledgeScopeError';
    this.code = code;
  }
}

/** The subset of the store the port reads. */
export interface CourseRevisionReader {
  listPinnedToCourse(courseId: string, options?: RevisionPinReadOptions): LessonRevision[];
}

export interface LearnerScope {
  companyId: string;
  userId: string;
}

export interface CourseKnowledgeSearchPortOptions {
  store: CourseRevisionReader;
  /** Server-built learner context for this company and user. Returns null when the learner is unknown. */
  getLearnerContext: (scope: LearnerScope) => Promise<LearnerContext | null | undefined> | LearnerContext | null | undefined;
  /** Environment used for the internal draft flag. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

const KB_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_QUERY_TERMS = 20;

/** Lowercase terms of at least two letters or digits, unique, capped. */
export function queryTerms(query: unknown): string[] {
  if (typeof query !== 'string') return [];
  const terms = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 2) terms.add(raw);
    if (terms.size >= MAX_QUERY_TERMS) break;
  }
  return [...terms];
}

/** Every non-empty string in a stripped body, in document order. The array index is the chunk index. */
function textLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) textLeaves(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) textLeaves(item, out);
  }
  return out;
}

const clampLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_CAP, Math.max(1, Math.floor(value)));
};

export function createCourseKnowledgeSearchPort(options: CourseKnowledgeSearchPortOptions): KnowledgeSearchPort {
  const env = options.env ?? process.env;

  return {
    async searchChunks(input) {
      const companyId = tryCompanyId(input?.companyId);
      if (companyId === null) throw new CourseKnowledgeScopeError('company_required');
      const userId = input.userId;
      if (typeof userId !== 'string' || userId.trim().length === 0) throw new CourseKnowledgeScopeError('user_required');

      const terms = queryTerms(input.query);
      if (terms.length === 0) return [];
      const limit = clampLimit(input.limit);

      const ctx = await options.getLearnerContext({ companyId, userId });
      if (!ctx) return [];
      if (tryCompanyId(ctx.companyId) !== companyId || ctx.learnerId !== userId) return [];
      if (!ctx.roleScope) return [];
      // A server-confirmed open assessment blocks retrieval for this learner. The client page alone does not.
      if (!guardAssessmentPage(ctx).allowed) return [];

      const readOptions = { allowDraftRevisions: internalDraftAccessEnabled(env) };
      const unlocked = new Set(unlockedLessonIds(ctx, ctx.roleScope));
      const activeCourses = [...new Set(
        ctx.enrolments
          .filter((e) => e.status === 'ACTIVE' && tryCompanyId(e.companyId) === companyId)
          .map((e) => e.courseId),
      )];

      const seen = new Set<string>();
      const matches: Array<{ hit: KnowledgeChunkHit; score: number }> = [];
      for (const courseId of activeCourses) {
        const revisions = options.store.listPinnedToCourse(courseId, { ...readOptions, verticalId: ctx.verticalId });
        for (const revision of revisions) {
          if (seen.has(revision.id)) continue;
          seen.add(revision.id);
          // Only ids the retrieval layer can cite. Others would be dropped there, so skip them here.
          if (!KB_ID.test(revision.id)) continue;
          if (!unlocked.has(revision.lessonId)) continue;
          if (!canRetrieve(ctx, revision, readOptions).allowed) continue;
          matches.push(...matchRevision(revision, terms, companyId));
        }
      }

      matches.sort((a, b) => b.score - a.score);
      return matches.slice(0, limit).map((m) => m.hit);
    },
  };
}

/** Keyword matches for one revision. Text is taken only from the stripped body and screened for answer material. */
function matchRevision(
  revision: LessonRevision,
  terms: readonly string[],
  companyId: string,
): Array<{ hit: KnowledgeChunkHit; score: number }> {
  const leaves = textLeaves(stripAssessmentData(revision.body));
  const secrets = answerMaterial(revision.body);
  const out: Array<{ hit: KnowledgeChunkHit; score: number }> = [];
  leaves.forEach((text, chunkIndex) => {
    if (!screenPassageText(text, secrets).allowed) return;
    const lower = text.toLowerCase();
    const matched = terms.filter((t) => lower.includes(t)).length;
    if (matched === 0) return;
    out.push({
      hit: {
        knowledgeBaseId: revision.id,
        chunkIndex,
        chunkText: text.slice(0, MAX_PASSAGE_CHARS),
        companyId,
        score: matched / terms.length,
      },
      score: matched / terms.length,
    });
  });
  return out;
}
