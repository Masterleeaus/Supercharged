/**
 * Progressive knowledge for the learner assistants. Pure functions only: no I/O and
 * no reads from the client. Every input comes from the server (progress, scores,
 * enrolments and approved business values).
 *
 * Tiers, in order:
 *   0 base      the shared base lessons (LMS "Shared:" modules). Every enrolled learner.
 *   1 vertical  the lessons of the role's service group. Unlocked when base is passed.
 *               Passing it means its own knowledge checks are at the threshold.
 *   2 course    the learner's enrolled courses in that group, plus the approved business
 *               values for those courses. Unlocked when the vertical tier is passed.
 *
 * A tier is passed when every knowledge check in it has a server-recorded score of at
 * least PASS_THRESHOLD_PERCENT. A tier with no knowledge checks counts as passed.
 */
import type { BusinessFieldValue } from "./knowledge/types.ts";

/** Pass mark for each knowledge check (ASSESSMENT-COVERAGE.csv: module pass 80%). */
export const PASS_THRESHOLD_PERCENT = 80;

/**
 * Number of distinct base-layer lesson ids in the owner's level file
 * (ALL-LESSON-LEVELS.csv, layer = base). Change this constant if the base changes.
 */
export const EXPECTED_BASE_LESSON_COUNT = 184;

export const TIER_NAMES = ["base", "vertical", "course"] as const;
export type TierName = (typeof TIER_NAMES)[number];

/**
 * The tier map. Keys: groupName is the LMS service group name (e.g. "Cleaning & Hygiene");
 * courseId is the canonical course slug used in lesson courseSlugs (e.g. "bond").
 */
export interface TierMap {
  /** Tier 0: shared base lesson ids. */
  base: string[];
  /** Tier 1: lesson ids of each service group, excluding base. */
  groupLessons: Record<string, string[]>;
  /** Tier 2: lesson ids of each course, excluding base and its group's lessons. */
  courseLessons: Record<string, string[]>;
  /** Course id -> service group name. */
  courseGroup: Record<string, string>;
  /** Course id -> business-field keys ("group.field") used by that course's lessons. */
  courseFields: Record<string, string[]>;
}

/** Server-supplied progress for one learner. The client never sets these fields. */
export interface LearnerProgress {
  companyId: string;
  /** Course ids the learner is actively enrolled in. */
  enrolledCourseSlugs: readonly string[];
  /** Latest server-recorded score per knowledge-check id, 0 to 100. */
  checkScores: Readonly<Record<string, number>>;
  /** Approved business values for the learner's company, from the server. */
  businessValues: readonly BusinessFieldValue[];
}

export interface TierUnlock {
  base: boolean;
  vertical: boolean;
  /** Enrolled courses in the role's group that are unlocked (course tier). */
  courses: string[];
  /** Every lesson id the role may retrieve for this learner right now. */
  lessonIds: string[];
  /** Approved business values the role may use for this learner right now. */
  businessValues: BusinessFieldValue[];
  /** The tier the learner must pass next, or null when everything is unlocked. Names only, no content. */
  nextTier: TierName | null;
}

/** True when every check id has a recorded score at or above the threshold. Missing scores fail. */
export function tierPassed(checkIds: readonly string[], scores: Readonly<Record<string, number>>): boolean {
  return checkIds.every((id) => {
    const score = scores[id];
    return typeof score === "number" && Number.isFinite(score) && score >= PASS_THRESHOLD_PERCENT;
  });
}

/**
 * The lessons, courses and business values this learner may use with a role.
 * `groupName` is the role's LMS service group. Pure: nothing is mutated.
 * Throws when the group is not in the tier map, so a role can never read an unknown tier.
 */
export function unlockedTiers(
  tierMap: TierMap,
  lessonCheckIds: Readonly<Record<string, readonly string[]>>,
  groupName: string,
  progress: LearnerProgress,
): TierUnlock {
  const groupLessons = tierMap.groupLessons[groupName];
  if (!groupLessons) throw new Error(`unknown service group "${groupName}"`);

  const checksOf = (ids: readonly string[]): string[] => ids.flatMap((id) => lessonCheckIds[id] ?? []);
  const enrolled = new Set(progress.enrolledCourseSlugs);
  const hasEnrolment = enrolled.size > 0;

  const base = hasEnrolment && tierPassed(checksOf(tierMap.base), progress.checkScores);
  const vertical = base && tierPassed(checksOf(groupLessons), progress.checkScores);

  // Course tier: only enrolled courses that belong to this role's group.
  const ownCourses = Object.keys(tierMap.courseGroup)
    .filter((course) => tierMap.courseGroup[course] === groupName && enrolled.has(course))
    .sort();
  const courses = vertical ? ownCourses : [];

  // Tier 1 (group lessons) opens once base is passed, so the learner can reach the
  // lessons that carry the group's checks. Tier 2 (courses) opens once tier 1 is passed.
  // Base lessons are open to every enrolled learner: they carry the base checks, so
  // withholding them until base passes would make base impossible to pass.
  const lessonIds = new Set<string>(hasEnrolment ? tierMap.base : []);
  if (base) for (const id of groupLessons) lessonIds.add(id);

  const keys = new Set<string>();
  for (const course of courses) {
    for (const id of tierMap.courseLessons[course] ?? []) lessonIds.add(id);
    for (const key of tierMap.courseFields[course] ?? []) keys.add(key);
  }

  // Business values: approved, this learner's company only, for keys of unlocked courses.
  const businessValues = courses.length === 0
    ? []
    : progress.businessValues.filter(
        (value) => value.companyId === progress.companyId && value.status === "APPROVED" && keys.has(value.fieldKey),
      );

  return {
    base,
    vertical,
    courses,
    lessonIds: [...lessonIds].sort(),
    businessValues,
    nextTier: !base ? "base" : !vertical ? "vertical" : null,
  };
}
