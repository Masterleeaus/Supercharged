/**
 * Binds the knowledge policy to the real tier map from the course-role generator.
 *
 * Kept apart from policy.ts on purpose: importing generate.ts reads the curriculum folder
 * when it loads, and the policy must stay pure. Pure functions in policy.ts keep their
 * tierMap parameter so tests can use small fixture maps.
 */
import { LESSON_CHECK_IDS, TIER_MAP } from '../generate.ts';
import {
  approvedBusinessValues,
  nextTierStep,
  unlockedLessonIds,
  validateTierMap,
} from './policy.ts';
import type { BusinessFieldValue, LearnerContext, LearnerProgress, RoleScope } from './types.ts';

export { LESSON_CHECK_IDS, TIER_MAP };

/** Problems with the real map. An empty list means it is usable. */
export const REAL_TIER_PROBLEMS: readonly string[] = validateTierMap(TIER_MAP);

/** Role scope for a service group, bound to the real map. */
export function realRoleScope(group: string): RoleScope {
  return { group, tiers: TIER_MAP };
}

/** Lesson ids a learner may use with a service group, from the real map. */
export function realUnlockedLessonIds(progress: LearnerProgress, group: string): string[] {
  return unlockedLessonIds(progress, realRoleScope(group));
}

/** Approved business values for a learner's company, limited to the real map's unlocked keys. */
export function realApprovedBusinessValues(
  progress: LearnerProgress,
  group: string,
  values: readonly BusinessFieldValue[],
): Record<string, unknown> {
  return approvedBusinessValues(progress, realRoleScope(group), values);
}

/** Next step for a learner on the real map. Names only the tier to pass. */
export function realNextTierStep(progress: LearnerProgress, group: string): string {
  return nextTierStep(progress, realRoleScope(group));
}

/** Context for a role on the real map, for use with prepareRetrieval. */
export function realContext(base: Omit<LearnerContext, 'roleScope'>, group: string): LearnerContext {
  return { ...base, roleScope: realRoleScope(group) };
}
