/**
 * The course assistant flag, kept apart from ./generate.ts. Reading the flag must not import the
 * curriculum generator, because generate.ts builds TIER_BUILD from the curriculum when it loads.
 * Default OFF: unset, blank or false means no course assistants and no Skilled Manager.
 */
import { featureEnabled } from "../../lib/feature-flags.ts";

export const COURSE_ASSISTANTS_FLAG = "WORKFORCE_COURSE_ASSISTANTS";

/** True only when WORKFORCE_COURSE_ASSISTANTS is set to an on value. Unset means off. */
export function courseAssistantRolesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return featureEnabled(COURSE_ASSISTANTS_FLAG, false, env);
}
