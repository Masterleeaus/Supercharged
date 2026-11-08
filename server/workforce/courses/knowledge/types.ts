/**
 * Input and output types for the course-knowledge policy. These describe data the
 * retrieval layer must supply. The policy itself performs no I/O.
 *
 * Every learner context carries a companyId (the Academy organisationId).
 */

/** Academy AcademyLessonRevision.status is a free string; only 'PUBLISHED' is retrievable. */
export type RevisionStatus = 'DRAFT' | 'REVIEW' | 'PUBLISHED' | 'RETIRED' | (string & {});

/** Academy EnrollmentStatus enum (prisma/schema.prisma L26-30). */
export type EnrolmentStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

/** Academy approved business-field status (prisma/schema.prisma L862). */
export type BusinessFieldStatus = 'DRAFT' | 'APPROVED' | 'RETIRED';

/** One enrolment the learner holds. companyId comes from the training assignment's organisationId. */
export interface EnrolmentRecord {
  courseId: string;
  companyId: string;
  status: EnrolmentStatus;
}

/**
 * An assessment the SERVER has open for the learner. Only these may change behaviour.
 * The retrieval layer builds them from its own state, never from client input.
 */
export interface OpenAssessment {
  kind: 'knowledge_check' | 'practical';
  status: 'in_progress' | 'submitted' | 'signed_off';
  learnerId: string;
  companyId: string;
  revisionId: string;
  lessonId: string;
}

/**
 * What the client says the learner is looking at. Untrusted: the server must confirm
 * an assessment before acting on kind 'assessment'.
 */
export interface ClientPageState {
  kind: 'assessment' | 'lesson' | 'other';
}

/** Score that passes a knowledge check (Academy pass mark, PASS6-KNOWLEDGE-CHECKS.md). */
export const PASS_PERCENT = 80;

/**
 * Progress from the server. checkedLessonIds lists every lesson that has a knowledge check.
 * bestScores holds the learner's best percentage per checked lesson. A lesson absent from
 * bestScores counts as not passed.
 */
export interface LearnerProgress {
  companyId: string;
  learnerId: string;
  enrolments: readonly EnrolmentRecord[];
  checkedLessonIds: readonly string[];
  bestScores: Readonly<Record<string, number>>;
}

/**
 * Distinct lesson ids in the 'Shared:' modules of curriculum/structure/COURSES-MODULES.json.
 * The owner's brief said 45; the file has 104. Flagged for the owner.
 */
export const BASE_TIER_LESSON_COUNT = 184;

/**
 * Tier map, exported by the course-role generator (generate.ts) as TIER_MAP.
 * Tier 0 base: shared lessons. Tier 1 vertical: lessons of the role's service group.
 * Tier 2 course and business: lessons of a learner's course in the group, plus approved
 * business keys for that course. Course keys are the course ids the enrolments carry.
 */
export interface TierMap {
  /** Tier 0: shared base lessons, available to every enrolled learner. */
  base: readonly string[];
  /** Tier 1: lessons of each service group, keyed by group. */
  groupLessons: Readonly<Record<string, readonly string[]>>;
  /** Tier 2: lessons of each course, keyed by course id. */
  courseLessons: Readonly<Record<string, readonly string[]>>;
  /** Course id to service group. */
  courseGroup: Readonly<Record<string, string>>;
  /** Tier 2: approved business-field keys each course uses, keyed by course id. */
  courseFields: Readonly<Record<string, readonly string[]>>;
}

/** The role's scope: its service group and the tier map it draws from. */
export interface RoleScope {
  group: string;
  tiers: TierMap;
}

export interface LearnerContext extends LearnerProgress {
  /** The vertical this assistant serves. Only lesson content from courses in this vertical is retrievable. */
  verticalId: string;
  roleScope: RoleScope;
  /** Server-confirmed open assessments for this learner. */
  openAssessments: readonly OpenAssessment[];
  /** Client-reported page. Untrusted. */
  clientPage: ClientPageState;
}

/** A course and the vertical it belongs to. */
export interface CourseRef {
  courseId: string;
  verticalId: string;
}

export interface LessonRevision {
  id: string;
  lessonId: string;
  status: RevisionStatus;
  contentHash: string;
  /** Courses whose published track pins this exact revision. */
  courses: readonly CourseRef[];
  body: unknown;
}

export interface BusinessFieldValue {
  companyId: string;
  fieldKey: string;
  value: unknown;
  status: BusinessFieldStatus | string;
}

/** A candidate passage from the retrieval layer, built from stripped revision content. */
export interface CandidatePassage {
  revisionId: string;
  lessonId: string;
  snapshotId: string;
  text: string;
}

export interface Citation {
  revisionId: string;
  snapshotId: string;
  contentHash: string;
}

export interface CitedPassage extends CandidatePassage {
  truncated: boolean;
}

export type DenyCode =
  | 'INVALID_CONTEXT'
  | 'OUT_OF_VERTICAL'
  | 'LESSON_LOCKED'
  | 'REVISION_NOT_PUBLISHED'
  | 'NOT_PLACED_IN_COURSE'
  | 'NO_ACTIVE_ENROLMENT'
  | 'PAGE_IN_ASSESSMENT'
  | 'LIVE_KNOWLEDGE_CHECK'
  | 'ANSWER_KEY_LEAK'
  | 'CITATION_MISSING';

export type Decision =
  | { allowed: true }
  | { allowed: false; code: DenyCode; reason: string; redirectVerticalId?: string };

/** Page guard: when allowed, suppressAssessmentContent tells the caller to withhold assessment material. */
export type PageDecision =
  | { allowed: true; suppressAssessmentContent: boolean }
  | { allowed: false; code: 'PAGE_IN_ASSESSMENT'; reason: string; redirect: string };

export type Result<T> = { ok: true; value: T } | { ok: false; code: DenyCode; reason: string };

export interface RetrievalAnswer {
  passages: CitedPassage[];
  citations: Citation[];
  limited: boolean;
}

/** Never an error: a refusal is a friendly redirect the learner can read. */
export type AgentReply =
  | { kind: 'answer'; passages: CitedPassage[]; citations: Citation[]; limited: boolean; assessmentContentWithheld: boolean }
  | { kind: 'redirect'; code: DenyCode; message: string; redirectVerticalId?: string };

export const MAX_PASSAGES = 5;
export const MAX_PASSAGE_CHARS = 1200;
