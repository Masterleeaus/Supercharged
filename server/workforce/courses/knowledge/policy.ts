/**
 * Pure policy for what a course agent may read and quote. No I/O.
 * Mirrors the Titan Academy rules listed in PORT-NOTES.md.
 */
import {
  BASE_TIER_LESSON_COUNT,
  MAX_PASSAGES,
  MAX_PASSAGE_CHARS,
  type TierMap,
  type AgentReply,
  type BusinessFieldValue,
  type CandidatePassage,
  type Citation,
  type CitedPassage,
  type CourseRef,
  type Decision,
  type DenyCode,
  type LearnerContext,
  type LearnerProgress,
  PASS_PERCENT,
  type RoleScope,
  type LessonRevision,
  type OpenAssessment,
  type PageDecision,
  type Result,
  type RetrievalAnswer,
} from './types.ts';
import { featureEnabled } from '../../../lib/feature-flags.ts';

/**
 * Internal test exception to rule 1. Off unless WORKFORCE_INTERNAL_DRAFT_COURSES is set to on.
 * When on, DRAFT revisions are retrievable under the same placement, vertical and enrolment rules.
 * REVIEW, RETIRED and any other status stay denied. Never enable this for learners or the public.
 */
export function internalDraftAccessEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return featureEnabled('WORKFORCE_INTERNAL_DRAFT_COURSES', false, env);
}

export interface RetrieveOptions {
  allowDraftRevisions?: boolean;
}

/** Same 56 keys as Academy business-lesson-fields.ts L2-58. */
export const APPROVED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'business.name', 'business.display_name', 'business.logo_url', 'business.support_phone', 'business.support_email',
  'business.service_area', 'business.timezone', 'services.enabled', 'services.service_group', 'services.vertical',
  'services.service_description', 'equipment.assigned_items', 'equipment.primary_tool', 'equipment.inspection_checklist',
  'equipment.maintenance_schedule', 'equipment.manufacturer_manual_url', 'materials.approved_products', 'materials.sds_links',
  'materials.handling_procedure', 'materials.storage_procedure', 'materials.waste_procedure', 'safety.required_ppe',
  'safety.site_hazards', 'safety.emergency_contact', 'safety.incident_reporting_procedure', 'safety.escalation_contact',
  'procedures.approved_sop', 'procedures.prestart_checklist', 'procedures.task_steps', 'procedures.completion_checklist',
  'procedures.quality_standard', 'jobs.scheduling_method', 'jobs.arrival_procedure', 'jobs.time_tracking',
  'jobs.photo_requirements', 'jobs.signoff_procedure', 'customers.communication_policy', 'customers.complaint_escalation',
  'customers.access_instructions', 'quality.inspection_checklist', 'quality.defect_reporting', 'quality.evidence_requirements',
  'pricing.pricing_method', 'pricing.minimum_charge', 'pricing.materials_cost_policy', 'pricing.quoting_approval',
  'staff.role', 'staff.supervisor_contact', 'staff.authorised_tasks', 'compliance.jurisdiction',
  'compliance.licence_requirements', 'compliance.policy_reference', 'assessment.business_question_set',
  'assessment.practical_equipment', 'assessment.assessor_role', 'assessment.signoff_requirements',
]);

/** Keys removed wherever they appear. Academy's list (curriculum.routes.ts L118) plus scoring keys. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'correctIndex', 'correctAnswer', 'correctAnswers', 'correct', 'isCorrect', 'answer', 'answers', 'answerKey', 'key',
  'explanation', 'rationale', 'feedbackCorrect', 'feedbackIncorrect',
  'score', 'scoring', 'points', 'marks', 'passMark', 'passingScore', 'threshold', 'weight', 'assessmentRubric',
]);

/** Whole subtrees removed. Knowledge-check questions are never quoted to an agent. */
const DROPPED_SUBTREES: ReadonlySet<string> = new Set(['knowledgeChecks', 'knowledgeCheck']);

/** Prose that signals answer material. A passage containing one is withheld. */
const ANSWER_MARKER = /\b(correct answer|answer key|marking key|correct option|correctIndex|feedbackCorrect)\b/i;

/** Friendly text for each refusal. A refusal is a redirect, never an error. */
const REDIRECT_MESSAGE: Record<DenyCode, string> = {
  INVALID_CONTEXT: 'I need to know who you are and which organisation you belong to before I can help with lesson content.',
  REVISION_NOT_PUBLISHED: 'This lesson version is not currently published, so I cannot use it. Try the current version from your course outline.',
  NOT_PLACED_IN_COURSE: 'This lesson is not part of a published course, so I cannot use it here.',
  NO_ACTIVE_ENROLMENT: 'I can only help with lessons from courses you are actively enrolled in. Check your enrolment with your organisation.',
  PAGE_IN_ASSESSMENT: 'You are in an assessment right now, so I cannot help with it. Once you finish, I am happy to help with general guidance on the lesson.',
  LIVE_KNOWLEDGE_CHECK: 'I cannot help with this knowledge check while it is in progress. I can still give general guidance on the lesson.',
  ANSWER_KEY_LEAK: 'I cannot share that part of the lesson. I can help with the steps and guidance instead.',
  CITATION_MISSING: 'I could not link that answer to a lesson version, so I have not shared it. Please try again.',
  OUT_OF_VERTICAL: 'This lesson is outside this assistant\'s area.',
  LESSON_LOCKED: 'This lesson is not unlocked yet.',
};

/** Friendly redirect for an out-of-vertical request, naming the vertical to ask. */
function verticalRedirect(verticalId: string): string {
  return `${REDIRECT_MESSAGE.OUT_OF_VERTICAL} Ask the "${verticalId}" assistant for this lesson.`;
}

const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

// ---------------------------------------------------------------------------
// Rules 1 and 2: published revisions, active enrolment
// ---------------------------------------------------------------------------

export function validateLearnerContext(ctx: LearnerContext): Decision {
  if (!isNonEmpty(ctx?.companyId)) return deny('INVALID_CONTEXT', 'companyId is required on every learner context');
  if (!isNonEmpty(ctx.learnerId)) return deny('INVALID_CONTEXT', 'learnerId is required');
  if (!isNonEmpty(ctx.verticalId)) return deny('INVALID_CONTEXT', 'verticalId is required; the assistant is scoped to one vertical');
  return ok();
}

/** Refuses a course outside the assistant's vertical and names the vertical to ask. */
export function guardCourseRequest(ctx: LearnerContext, course: CourseRef): Decision {
  const base = validateLearnerContext(ctx);
  if (!base.allowed) return base;
  if (course.verticalId !== ctx.verticalId) {
    return deny('OUT_OF_VERTICAL', `Course ${course.courseId} is in vertical "${course.verticalId}", not "${ctx.verticalId}"`, course.verticalId);
  }
  return ok();
}

/**
 * Rule 1 (published only), the vertical limit (the revision must be pinned by a course in the
 * learner's vertical), and rule 2 (ACTIVE enrolment in such a course, for the same company).
 */
export function canRetrieve(
  ctx: LearnerContext,
  revision: LessonRevision,
  options: RetrieveOptions = {},
): Decision {
  const base = validateLearnerContext(ctx);
  if (!base.allowed) return base;
  const draftAllowed = options.allowDraftRevisions === true && revision.status === 'DRAFT';
  if (revision.status !== 'PUBLISHED' && !draftAllowed) {
    return deny('REVISION_NOT_PUBLISHED', `Revision is ${String(revision.status)}; only PUBLISHED revisions are retrievable`);
  }
  const courses = revision.courses ?? [];
  if (courses.length === 0) return deny('NOT_PLACED_IN_COURSE', 'Revision is not pinned by any published course track');
  const inVertical = courses.filter((c) => c.verticalId === ctx.verticalId);
  if (inVertical.length === 0) {
    return deny('OUT_OF_VERTICAL', `This lesson belongs to vertical "${courses[0].verticalId}", not "${ctx.verticalId}"`, courses[0].verticalId);
  }
  const courseIds = new Set(inVertical.map((c) => c.courseId));
  const active = ctx.enrolments.some((e) => e.status === 'ACTIVE' && e.companyId === ctx.companyId && courseIds.has(e.courseId));
  if (!active) return deny('NO_ACTIVE_ENROLMENT', 'No ACTIVE enrolment in a course in this vertical that pins this revision, for this company');
  return ok();
}

// ---------------------------------------------------------------------------
// Progressive tiers: tier 0 base, tier 1 service group, tier 2 course
// ---------------------------------------------------------------------------

const activeCourseIds = (p: LearnerProgress): Set<string> =>
  new Set(p.enrolments.filter((e) => e.status === 'ACTIVE' && e.companyId === p.companyId).map((e) => e.courseId));

/**
 * Lesson score from per-check scores: the minimum over the lesson's checks, so a lesson passes only when
 * every one of its checks is at or above PASS_PERCENT. A lesson with any missing check score gets no score.
 * lessonCheckIds comes from the generator (LESSON_CHECK_IDS).
 */
export function lessonScoresFromChecks(
  checkScores: Readonly<Record<string, number>>,
  lessonCheckIds: Readonly<Record<string, readonly string[]>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [lesson, checks] of Object.entries(lessonCheckIds)) {
    if (checks.length === 0) continue;
    const scores = checks.map((c) => checkScores[c]);
    if (scores.every((s) => typeof s === 'number' && Number.isFinite(s))) out[lesson] = Math.min(...scores);
  }
  return out;
}

/**
 * A tier is passed when it has at least one knowledge check and every checked lesson in it
 * has a server-recorded best score at or above PASS_PERCENT. A tier with no checks cannot be
 * passed, so it keeps the tiers below it locked (fail closed).
 */
export function tierPassed(lessonIds: readonly string[], progress: LearnerProgress): boolean {
  // A tier with no lessons has nothing to pass. Three groups have none (Specialist hygiene, Aquatic,
  // Personal, fitness and pet), and failing them closed would lock their course tiers for good.
  if (lessonIds.length === 0) return true;
  const checked = lessonIds.filter((id) => progress.checkedLessonIds.includes(id));
  if (checked.length === 0) return false;
  return checked.every((id) => {
    const score = progress.bestScores[id];
    return typeof score === 'number' && score >= PASS_PERCENT;
  });
}

/**
 * Lesson ids this learner may use, from server progress and the role's scope.
 * - Tier 0 (base): every learner with an ACTIVE enrolment.
 * - Tier 1 (group): only after the base tier passes, and only with an ACTIVE enrolment in a course of the role's group.
 * - Tier 2 (course): only after the group tier passes, and only for the learner's ACTIVE courses in the role's group.
 * Lessons of other groups are never included.
 */
export function unlockedLessonIds(progress: LearnerProgress, roleScope: RoleScope): string[] {
  if (!isNonEmpty(progress?.companyId) || !isNonEmpty(progress.learnerId)) return [];
  const active = activeCourseIds(progress);
  if (active.size === 0) return [];
  const { tiers, group } = roleScope;
  const out = new Set<string>(tiers.base);
  // An unknown group is not an empty group: it gets base lessons only.
  if (!(group in tiers.groupLessons)) return sorted(out);
  if (!tierPassed(tiers.base, progress)) return sorted(out);
  const groupCourses = [...active].filter((c) => tiers.courseGroup[c] === group);
  if (groupCourses.length === 0) return sorted(out);
  const groupLessons = tiers.groupLessons[group] ?? [];
  for (const id of groupLessons) out.add(id);
  if (!tierPassed(groupLessons, progress)) return sorted(out);
  for (const courseId of groupCourses) for (const id of tiers.courseLessons[courseId] ?? []) out.add(id);
  return sorted(out);
}

/**
 * Tier 2 business keys: approved business-field keys for the learner's courses in the role's group.
 * Unlocked only after the base and vertical tiers pass. Company scoping is applied by approvedBusinessValues.
 */
export function unlockedBusinessFieldKeys(progress: LearnerProgress, roleScope: RoleScope): string[] {
  const { tiers, group } = roleScope;
  const groupLessons = tiers.groupLessons[group] ?? [];
  if (!tierPassed(tiers.base, progress) || !tierPassed(groupLessons, progress)) return [];
  const keys = new Set<string>();
  for (const courseId of activeCourseIds(progress)) {
    if (tiers.courseGroup[courseId] !== group) continue;
    for (const key of tiers.courseFields[courseId] ?? []) keys.add(key);
  }
  return sorted(keys);
}

/** Approved business values for the learner's company, limited to the keys unlocked at tier 2. */
export function approvedBusinessValues(
  progress: LearnerProgress,
  roleScope: RoleScope,
  values: readonly BusinessFieldValue[],
): Record<string, unknown> {
  const allowed = new Set(unlockedBusinessFieldKeys(progress, roleScope));
  const approved = selectApprovedFieldValues(progress.companyId, values).values;
  return Object.fromEntries(Object.entries(approved).filter(([key]) => allowed.has(key)));
}

/**
 * Checks a tier map before use. Returns problems; an empty list means the map is usable.
 * A base tier that is not BASE_TIER_LESSON_COUNT lessons is reported, not silently accepted.
 */
export function validateTierMap(tiers: TierMap): string[] {
  const problems: string[] = [];
  if (tiers.base.length !== BASE_TIER_LESSON_COUNT) {
    problems.push(`base tier has ${tiers.base.length} lessons; expected ${BASE_TIER_LESSON_COUNT} from the 'Shared:' modules`);
  }
  if (new Set(tiers.base).size !== tiers.base.length) problems.push('base tier has duplicate lesson ids');
  for (const [course, group] of Object.entries(tiers.courseGroup)) {
    if (!(group in tiers.groupLessons)) problems.push(`course ${course} maps to group "${group}", which has no vertical lessons`);
  }
  return problems;
}

/** What the learner needs to do next, without naming or describing locked lessons. */
export function nextTierStep(progress: LearnerProgress, roleScope: RoleScope): string {
  const { tiers, group } = roleScope;
  if (activeCourseIds(progress).size === 0) return 'Enrol in a course to unlock lessons.';
  if (!tierPassed(tiers.base, progress)) return `Pass the shared base knowledge checks (${PASS_PERCENT}% or more) to unlock your service group lessons.`;
  const active = activeCourseIds(progress);
  const hasGroupCourse = [...active].some((c) => tiers.courseGroup[c] === group);
  if (!hasGroupCourse) return 'Enrol in a course from your service group to unlock its lessons.';
  if (!tierPassed(tiers.groupLessons[group] ?? [], progress)) return `Pass your service group knowledge checks (${PASS_PERCENT}% or more) to unlock course lessons.`;
  return '';
}

function sorted(set: Set<string>): string[] { return [...set].sort(); }

// ---------------------------------------------------------------------------
// Assessment state: the client reports a page, the server confirms the assessment
// ---------------------------------------------------------------------------

/** Server-confirmed: in progress, for this learner and company. Only these count. */
export function confirmedOpenAssessments(ctx: LearnerContext): OpenAssessment[] {
  return ctx.openAssessments.filter((a) =>
    a.status === 'in_progress' && a.learnerId === ctx.learnerId && a.companyId === ctx.companyId);
}

/**
 * When the client says the learner is on an assessment page:
 * - the server confirms an open assessment: refuse with a friendly redirect;
 * - the server confirms nothing: answer normally, but withhold assessment content.
 * A client claim alone never blocks the answer and never reveals assessment material.
 */
export function guardAssessmentPage(ctx: LearnerContext): PageDecision {
  if (ctx.clientPage?.kind !== 'assessment') return { allowed: true, suppressAssessmentContent: false };
  if (confirmedOpenAssessments(ctx).length > 0) {
    return { allowed: false, code: 'PAGE_IN_ASSESSMENT', reason: REDIRECT_MESSAGE.PAGE_IN_ASSESSMENT, redirect: REDIRECT_MESSAGE.PAGE_IN_ASSESSMENT };
  }
  return { allowed: true, suppressAssessmentContent: true };
}

// ---------------------------------------------------------------------------
// Rule 3: answer keys and scoring data never leave the policy
// ---------------------------------------------------------------------------

/** Returns a copy of content with answer, scoring and knowledge-check material removed at every depth. */
export function stripAssessmentData(content: unknown): unknown {
  if (Array.isArray(content)) return content.map(stripAssessmentData);
  if (!content || typeof content !== 'object') return content;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key) || DROPPED_SUBTREES.has(key)) continue;
    out[key] = stripAssessmentData(value);
  }
  return out;
}

/** The answer text and explanations a revision holds. Used to screen passages for leaks. */
export function answerMaterial(body: unknown): string[] {
  const found: string[] = [];
  for (const check of collectChecks(body)) {
    const options = Array.isArray(check.options) ? check.options : [];
    const index = check.correctIndex;
    if (typeof index === 'number' && typeof options[index] === 'string') found.push(options[index]);
    if (typeof check.explanation === 'string') found.push(check.explanation);
  }
  return found.filter((s) => s.trim().length >= 4);
}

function collectChecks(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const list = Array.isArray(record.knowledgeChecks) ? record.knowledgeChecks : Array.isArray(record.knowledgeCheck) ? record.knowledgeCheck : [];
  return list.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object');
}

/** Refuses prose that contains an answer marker or any answer text from the revision. */
export function screenPassageText(text: string, secrets: readonly string[]): Decision {
  if (ANSWER_MARKER.test(text)) return deny('ANSWER_KEY_LEAK', REDIRECT_MESSAGE.ANSWER_KEY_LEAK);
  const lower = text.toLowerCase();
  if (secrets.some((s) => lower.includes(s.toLowerCase()))) return deny('ANSWER_KEY_LEAK', REDIRECT_MESSAGE.ANSWER_KEY_LEAK);
  return ok();
}

// ---------------------------------------------------------------------------
// Rule 4: questions from a knowledge check in progress (server-confirmed only)
// ---------------------------------------------------------------------------

const CHECK_PHRASE = /\b(knowledge check|quiz|question\s*\d+|which (option|answer)|correct answer|the answer to)\b/i;
const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'which', 'that', 'this', 'from', 'are', 'you', 'your', 'how', 'when', 'where', 'should']);

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9:./-]+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

/**
 * While the server confirms a knowledge check in progress for this revision, its questions are not answered.
 * A question counts as one of them when it quotes a check question or option, uses a check phrase, or shares most
 * of its words with a check question. Other questions about the lesson get general guidance.
 */
export function guardAssessmentQuestion(ctx: LearnerContext, revision: LessonRevision, questionText: string): Decision {
  const base = validateLearnerContext(ctx);
  if (!base.allowed) return base;
  const live = confirmedOpenAssessments(ctx).some((a) =>
    a.kind === 'knowledge_check' && (a.revisionId === revision.id || a.lessonId === revision.lessonId));
  if (!live) return ok();
  const checks = collectChecks(revision.body);
  const lower = questionText.toLowerCase();
  if (CHECK_PHRASE.test(questionText)) return deny('LIVE_KNOWLEDGE_CHECK', REDIRECT_MESSAGE.LIVE_KNOWLEDGE_CHECK);
  for (const check of checks) {
    const q = typeof check.question === 'string' ? check.question.toLowerCase() : '';
    if (q && (lower.includes(q) || q.includes(lower.trim()))) return deny('LIVE_KNOWLEDGE_CHECK', REDIRECT_MESSAGE.LIVE_KNOWLEDGE_CHECK);
    const options = Array.isArray(check.options) ? check.options.filter((o): o is string => typeof o === 'string') : [];
    if (options.some((o) => o.trim().length >= 4 && lower.includes(o.toLowerCase()))) return deny('LIVE_KNOWLEDGE_CHECK', REDIRECT_MESSAGE.LIVE_KNOWLEDGE_CHECK);
  }
  const qTokens = tokens(questionText);
  for (const check of checks) {
    const checkTokens = new Set(tokens(`${String(check.question ?? '')} ${(Array.isArray(check.options) ? check.options : []).join(' ')}`));
    const shared = qTokens.filter((t) => checkTokens.has(t)).length;
    if (qTokens.length >= 3 && shared >= 3 && shared / qTokens.length >= 0.5) return deny('LIVE_KNOWLEDGE_CHECK', REDIRECT_MESSAGE.LIVE_KNOWLEDGE_CHECK);
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Rule 5: business values from approved organisation fields only
// ---------------------------------------------------------------------------

/**
 * Keeps values that are APPROVED, belong to the company, use an approved key, and have a
 * displayable type. A key with more than one approved row is excluded as ambiguous.
 */
export function selectApprovedFieldValues(
  companyId: string,
  values: readonly BusinessFieldValue[],
): { values: Record<string, unknown>; excludedKeys: string[] } {
  const approved = new Map<string, unknown[]>();
  for (const row of values) {
    if (row.companyId !== companyId || row.status !== 'APPROVED' || !APPROVED_FIELD_KEYS.has(row.fieldKey)) continue;
    const list = approved.get(row.fieldKey) ?? [];
    list.push(row.value);
    approved.set(row.fieldKey, list);
  }
  const out: Record<string, unknown> = {};
  const excluded: string[] = [];
  for (const [key, list] of approved) {
    if (list.length !== 1) { excluded.push(key); continue; }
    const value = list[0];
    const displayable = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
    if (displayable) out[key] = value; else excluded.push(key);
  }
  return { values: out, excludedKeys: excluded.sort() };
}

// ---------------------------------------------------------------------------
// Rule 6: citations
// ---------------------------------------------------------------------------

const HASH = /^[a-f0-9]{64}$/;

/** Every passage needs a revision id, snapshot id and SHA-256 content hash. Returns one citation per pair. */
export function buildCitations(passages: readonly (Citation & { text: string })[]): Result<Citation[]> {
  const seen = new Map<string, Citation>();
  for (const p of passages) {
    if (!isNonEmpty(p.revisionId) || !isNonEmpty(p.snapshotId) || !HASH.test(p.contentHash ?? '')) {
      return { ok: false, code: 'CITATION_MISSING', reason: 'Every passage needs revisionId, snapshotId and a SHA-256 contentHash' };
    }
    const key = `${p.revisionId}\u0000${p.snapshotId}`;
    if (!seen.has(key)) seen.set(key, { revisionId: p.revisionId, snapshotId: p.snapshotId, contentHash: p.contentHash });
  }
  return { ok: true, value: [...seen.values()] };
}

// ---------------------------------------------------------------------------
// Rule 7: passage limits
// ---------------------------------------------------------------------------

/** Keeps at most MAX_PASSAGES passages and cuts each to MAX_PASSAGE_CHARS at a word boundary. */
export function limitPassages(passages: readonly CandidatePassage[]): { passages: CitedPassage[]; limited: boolean } {
  let limited = passages.length > MAX_PASSAGES;
  const kept = passages.slice(0, MAX_PASSAGES).map((p) => {
    if (p.text.length <= MAX_PASSAGE_CHARS) return { ...p, truncated: false };
    limited = true;
    const cut = p.text.slice(0, MAX_PASSAGE_CHARS);
    const space = cut.lastIndexOf(' ');
    const text = space >= MAX_PASSAGE_CHARS * 0.8 ? cut.slice(0, space) : cut;
    return { ...p, text, truncated: true };
  });
  return { passages: kept, limited };
}

// ---------------------------------------------------------------------------
// Pipeline: every rule in order. Always returns a reply, never throws.
// ---------------------------------------------------------------------------

/**
 * Order: page guard, publication and enrolment, live knowledge-check guard (when a question is given),
 * passage screening for answer material, passage limits, citations.
 * Candidate text must come from stripAssessmentData(revision.body).
 */
export function prepareRetrieval(
  ctx: LearnerContext,
  revision: LessonRevision,
  candidates: readonly CandidatePassage[],
  questionText?: string,
): AgentReply {
  const page = guardAssessmentPage(ctx);
  if (!page.allowed) return redirect('PAGE_IN_ASSESSMENT', page.redirect);
  const access = canRetrieve(ctx, revision, { allowDraftRevisions: internalDraftAccessEnabled() });
  if (!access.allowed) return denyToRedirect(access);
  const unlocked = new Set(unlockedLessonIds(ctx, ctx.roleScope));
  if (!unlocked.has(revision.lessonId)) {
    const step = nextTierStep(ctx, ctx.roleScope);
    return redirect('LESSON_LOCKED', `This lesson is not unlocked yet. ${step}`.trim());
  }
  if (questionText !== undefined) {
    const guard = guardAssessmentQuestion(ctx, revision, questionText);
    if (!guard.allowed) return denyToRedirect(guard);
  }
  const secrets = answerMaterial(revision.body);
  const screened: CandidatePassage[] = [];
  for (const p of candidates) {
    // Passages from another revision, or from a lesson the learner has not unlocked, are dropped silently.
    if (p.revisionId !== revision.id || !unlocked.has(p.lessonId)) continue;
    if (!isNonEmpty(p.snapshotId)) return redirect('CITATION_MISSING', REDIRECT_MESSAGE.CITATION_MISSING);
    if (screenPassageText(p.text, secrets).allowed) screened.push(p);
  }
  const limited = limitPassages(screened);
  const citations = buildCitations(limited.passages.map((p) => ({ ...p, contentHash: revision.contentHash })));
  if (!citations.ok) return redirect(citations.code, REDIRECT_MESSAGE.CITATION_MISSING);
  const answer: RetrievalAnswer = { passages: limited.passages, citations: citations.value, limited: limited.limited };
  return { kind: 'answer', ...answer, assessmentContentWithheld: page.suppressAssessmentContent };
}

// ---------------------------------------------------------------------------

function ok(): Decision { return { allowed: true }; }
function deny(code: DenyCode, reason: string, redirectVerticalId?: string): Decision {
  return redirectVerticalId === undefined ? { allowed: false, code, reason } : { allowed: false, code, reason, redirectVerticalId };
}
function redirect(code: DenyCode, message: string, redirectVerticalId?: string): AgentReply {
  return redirectVerticalId === undefined ? { kind: 'redirect', code, message } : { kind: 'redirect', code, message, redirectVerticalId };
}
function denyToRedirect(d: Extract<Decision, { allowed: false }>): AgentReply {
  if (d.code === 'OUT_OF_VERTICAL' && d.redirectVerticalId !== undefined) {
    return redirect(d.code, verticalRedirect(d.redirectVerticalId), d.redirectVerticalId);
  }
  return redirect(d.code, REDIRECT_MESSAGE[d.code]);
}
