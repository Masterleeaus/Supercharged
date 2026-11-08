/**
 * Flag-gated registration of the learner assistant roles built from the Titan Academy LMS.
 *
 * Default OFF. With WORKFORCE_COURSE_ASSISTANTS unset, blank or false, registerCourseAssistantRoles
 * returns the catalogue it was given, as the same object. Nothing here is wired into boot: no server
 * path calls registerCourseAssistantRoles yet.
 *
 * Importing this module imports ./generate.ts, which builds TIER_BUILD from the curriculum at import
 * time. Keep this module off the boot path until that build is intended to run.
 *
 * Inputs are never mutated. The catalogue returned is a new Map.
 */
import { featureEnabled } from "../../lib/feature-flags.ts";
import type { RoleCatalogue } from "../catalogue/loader.ts";
import type { RoleDefinition } from "../catalogue/role.schema.ts";
import { validateRoleDefinition, type ValidationIssue } from "../catalogue/validate.ts";
import { COURSE_KNOWLEDGE_TOOL_ID } from "./course-agent.template.ts";
import { generateAssistantRoles, resolveCurriculumRoot } from "./generate.ts";

export const COURSE_ASSISTANTS_FLAG = "WORKFORCE_COURSE_ASSISTANTS";

/** True only when WORKFORCE_COURSE_ASSISTANTS is set to an on value. Unset means off. */
export function courseAssistantRolesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return featureEnabled(COURSE_ASSISTANTS_FLAG, false, env);
}

export interface CourseAssistantBuild {
  /** Roles that passed the catalogue validator, parsed (defaults applied). */
  roles: RoleDefinition[];
  /** One entry per role or step that failed. Never thrown. */
  problems: ValidationIssue[];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns a problem message when a generated role is not read-only, or null when it is.
 * Course assistants may use course_knowledge.search and nothing else, declared as read.
 */
function readOnlyProblem(input: Record<string, unknown>): string | null {
  const tools: unknown[] = Array.isArray(input.tools) ? input.tools : [];
  const extra = tools.filter((tool) => tool !== COURSE_KNOWLEDGE_TOOL_ID);
  if (extra.length > 0) {
    return `uses tools other than ${COURSE_KNOWLEDGE_TOOL_ID}: ${extra.map(String).join(", ")}`;
  }
  const access = (input.toolAccess ?? {}) as Record<string, unknown>;
  const declared = access[COURSE_KNOWLEDGE_TOOL_ID];
  if (declared !== undefined && declared !== "read") {
    return `declares ${COURSE_KNOWLEDGE_TOOL_ID} as ${String(declared)}, not read`;
  }
  return null;
}

/**
 * Builds and validates the course assistant roles from the curriculum. Writes nothing.
 * `root` defaults to ACADEMY_CURRICULUM_ROOT (read from `env`). A bad curriculum root or a bad
 * role is reported in `problems`; this function does not throw.
 *
 * Each role gets toolAccess { course_knowledge.search: "read" }. The generator leaves toolAccess
 * empty, and the catalogue treats an undeclared tool as write, so this sets the declared access.
 */
export function buildCourseAssistantRoles(root?: string, env: NodeJS.ProcessEnv = process.env): CourseAssistantBuild {
  let inputs: unknown[];
  try {
    inputs = generateAssistantRoles(root ?? resolveCurriculumRoot(env));
  } catch (error) {
    return {
      roles: [],
      problems: [{ path: "curriculum", message: `could not generate course assistants: ${reason(error)}` }],
    };
  }

  const roles: RoleDefinition[] = [];
  const problems: ValidationIssue[] = [];
  const seen = new Set<string>();

  inputs.forEach((input, index) => {
    const label = `course-assistants[${index}]`;
    try {
      if (typeof input !== "object" || input === null) {
        problems.push({ path: label, message: "generated role is not an object" });
        return;
      }
      const record = input as Record<string, unknown>;
      const blocked = readOnlyProblem(record);
      if (blocked) {
        problems.push({ path: label, message: `course assistant ${blocked}` });
        return;
      }
      const access = (record.toolAccess ?? {}) as Record<string, unknown>;
      const result = validateRoleDefinition({
        ...record,
        toolAccess: { ...access, [COURSE_KNOWLEDGE_TOOL_ID]: "read" },
      });
      if (result.ok === false) {
        for (const issue of result.errors) {
          problems.push({ path: `${label}.${issue.path}`, message: issue.message });
        }
        return;
      }
      if (seen.has(result.role.id)) {
        problems.push({ path: `${label}.id`, message: `duplicate course assistant id "${result.role.id}"` });
        return;
      }
      seen.add(result.role.id);
      roles.push(result.role);
    } catch (error) {
      problems.push({ path: label, message: `threw during validation: ${reason(error)}` });
    }
  });

  return { roles, problems };
}

export interface CourseAssistantRegistration {
  /** The catalogue to use. The same object as the input when the flag is off. */
  catalogue: RoleCatalogue;
  /** Ids of the course assistants added. Empty when the flag is off. */
  added: string[];
  /** Everything that was not added, and why. */
  problems: ValidationIssue[];
}

/**
 * Returns a catalogue with the course assistants added when WORKFORCE_COURSE_ASSISTANTS is on.
 *   Flag off: returns { catalogue: <the input object itself>, added: [], problems: [] }.
 *   Flag on:  returns a new Map with every input role plus the course assistants. The input is not changed.
 * A course assistant whose id is already in the catalogue is reported and not added. An existing role
 * is never overwritten. An assistant whose handoff target is not in the result is also reported and not added.
 */
export function registerCourseAssistantRoles(
  catalogue: RoleCatalogue,
  env: NodeJS.ProcessEnv = process.env,
): CourseAssistantRegistration {
  if (!courseAssistantRolesEnabled(env)) {
    return { catalogue, added: [], problems: [] };
  }

  const build = buildCourseAssistantRoles(undefined, env);
  const problems: ValidationIssue[] = [...build.problems];

  let accepted: RoleDefinition[] = [];
  for (const role of build.roles) {
    if (catalogue.has(role.id)) {
      problems.push({
        path: `course-assistants.${role.id}`,
        message: `duplicate role id "${role.id}" is already in the catalogue; not added`,
      });
      continue;
    }
    accepted.push(role);
  }

  // Drop any assistant whose handoff target would not resolve. Repeat, since a drop can strand another.
  for (;;) {
    const ids = new Set<string>([...catalogue.keys(), ...accepted.map((role) => role.id)]);
    const next = accepted.filter((role) => {
      const missing = role.handoffTo.filter((target) => !ids.has(target));
      if (missing.length === 0) return true;
      problems.push({
        path: `course-assistants.${role.id}.handoffTo`,
        message: `handoff target "${missing.join('", "')}" is not a role in the catalogue; not added`,
      });
      return false;
    });
    if (next.length === accepted.length) break;
    accepted = next;
  }

  const merged = new Map<string, RoleDefinition>(catalogue);
  for (const role of accepted) merged.set(role.id, role);
  return { catalogue: merged, added: accepted.map((role) => role.id), problems };
}

export interface CourseAssistantToolReport {
  /** Sorted, de-duplicated tool ids used by the course assistants. */
  toolIds: string[];
  /** Problems from building the roles. Never thrown. */
  problems: ValidationIssue[];
}

/**
 * Reports the tool ids the course assistants use. Independent of the flag, so a verifier can check
 * the built roles whether or not they are registered. Never throws.
 */
export function courseAssistantToolIds(root?: string, env: NodeJS.ProcessEnv = process.env): CourseAssistantToolReport {
  const build = buildCourseAssistantRoles(root, env);
  const ids = new Set<string>();
  for (const role of build.roles) for (const tool of role.tools) ids.add(tool);
  return { toolIds: [...ids].sort(), problems: build.problems };
}
