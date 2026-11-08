/**
 * Builds the learner assistant roles and the progressive tier map from the Titan Academy
 * LMS. Read only: nothing is written.
 *
 * Roles: one per LMS service group (structure/COURSES-MODULES.json, field `group`), id
 * `assistant-<group-slug>`, with the group's courses as its focus.
 *
 * Tier map (TIER_MAP), built from the owner's level file (ACADEMY_LEVELS_CSV):
 *   base          lessons whose layer is base
 *   groupLessons  lessons whose layer is group, under the course's service group
 *   courseLessons lessons whose layer is business or high-risk, under that course
 * Service group membership of each course comes from structure/COURSES-MODULES.json.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RoleInput, Vertical } from "../catalogue/role.schema.ts";
import {
  verticalAssistantRole,
  verticalAssistantRoleId,
  type CourseScopeItem,
} from "./course-agent.template.ts";
import type { TierMap } from "./progression.ts";

/** Default LMS curriculum root. Override with ACADEMY_CURRICULUM_ROOT. */
export const DEFAULT_CURRICULUM_ROOT = "/home/claude/scan10/LMS/lms-main/curriculum";

/**
 * Folders that are not courses. SLUG-MAP.json says high-risk is a layer, kept as a folder only.
 * high-risk-licence-addon is an optional add-on, not one of the 43 courses in COURSES-MODULES.json,
 * with ownerApproval "pending" (owner decision 2026-11-04). It is excluded from training until approved.
 */
export const NON_COURSE_FOLDERS: readonly string[] = ["high-risk", "high-risk-licence-addon"];

const SHARED_STUB = "SHARED-REFERENCES.json";

/** LMS service group -> persona. Verticals are the schema enum values this group serves. */
export const SERVICE_GROUPS: Readonly<Record<string, { slug: string; title: string; verticals: Vertical[] }>> = {
  "Cleaning & Hygiene": { slug: "cleaning-and-hygiene", title: "Cleaning and hygiene", verticals: ["cleaning"] },
  "Specialist hygiene": { slug: "specialist-hygiene", title: "Specialist hygiene", verticals: ["cleaning"] },
  "Exterior, height & access": { slug: "exterior-height-access", title: "Exterior, height and access", verticals: ["cleaning"] },
  Aquatic: { slug: "aquatic", title: "Aquatic", verticals: ["pool", "general_field_service"] },
  "Outdoor & garden": { slug: "outdoor-and-garden", title: "Outdoor and garden", verticals: ["garden"] },
  "Property & trades": { slug: "property-and-trades", title: "Property and trades", verticals: ["handyman", "painting", "locksmith"] },
  "Personal, fitness & pet": { slug: "personal-fitness-and-pet", title: "Personal, fitness and pet services", verticals: ["general_field_service"] },
};

interface CourseRecord {
  folder: string;
  slug: string;
  title: string;
  group: string;
  lessonFiles: number;
  lessonIds: string[];
  sharedLessonIds: string[];
  lessonCourseSlugs: string[][];
}

export interface CourseLessonCount {
  folder: string;
  slug: string;
  lessonFiles: number;
}

export interface GroupPlan {
  roleId: string;
  groupSlug: string;
  groupName: string;
  verticals: Vertical[];
  courses: CourseRecord[];
  handoffTo: string[];
}

export interface TierBuild {
  tierMap: TierMap;
  /** Knowledge-check ids per lesson id, for every lesson in any tier. */
  lessonCheckIds: Record<string, string[]>;
  /** Lesson ids listed in a tier that have no lesson file. Must be empty. */
  missingFiles: string[];
  /** Lesson ids with rows in more than one layer in the level file. */
  layerConflicts: string[];
  /** Group lesson ids listed under more than one service group. */
  multiGroupLessons: string[];
  /** Distinct lesson ids per layer. */
  idsPerLayer: Record<string, number>;
  /** Number of rows in the level file. */
  rowCount: number;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listJson(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

function readCourses(root: string): CourseRecord[] {
  const coursesDir = join(root, "courses");
  const modules = readJson(join(root, "structure", "COURSES-MODULES.json")) as {
    courses: { slug: string; title: string; group: string }[];
  };
  const slugMap = readJson(join(root, "structure", "SLUG-MAP.json")) as {
    folderToCanonical: Record<string, string>;
  };
  const canonical = new Map(modules.courses.map((c) => [c.slug, c]));

  // Folders map to canonical slugs. Canonical courses without a folder (construction)
  // still get a record, with zero lesson files.
  const folderBySlug = new Map<string, string>();
  for (const folder of readdirSync(coursesDir).sort()) {
    if (!statSync(join(coursesDir, folder)).isDirectory() || NON_COURSE_FOLDERS.includes(folder)) continue;
    const slug = slugMap.folderToCanonical[folder] ?? folder;
    if (!canonical.has(slug)) throw new Error(`course folder "${folder}" has no entry in COURSES-MODULES.json`);
    folderBySlug.set(slug, folder);
  }

  return [...modules.courses]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((course) => {
      if (!SERVICE_GROUPS[course.group]) throw new Error(`service group "${course.group}" has no persona mapping`);
      const folder = folderBySlug.get(course.slug) ?? "";
      const record: CourseRecord = {
        folder,
        slug: course.slug,
        title: course.title,
        group: course.group,
        lessonFiles: 0,
        lessonIds: [],
        sharedLessonIds: [],
        lessonCourseSlugs: [],
      };
      if (folder) {
        const dir = join(coursesDir, folder);
        for (const file of listJson(dir)) {
          const body = readJson(join(dir, file)) as Record<string, unknown>;
          if (file === SHARED_STUB) {
            record.sharedLessonIds = (body.sharedLessonIds as string[]) ?? [];
            continue;
          }
          record.lessonFiles += 1;
          record.lessonIds.push(String(body.id ?? file.replace(/\.json$/, "")));
          record.lessonCourseSlugs.push((body.courseSlugs as string[]) ?? []);
        }
      }
      return record;
    });
}

/** Count of lesson files per course folder (shared-reference stubs are not lesson files). */
export function courseLessonCounts(root: string = DEFAULT_CURRICULUM_ROOT): CourseLessonCount[] {
  return readCourses(root).map((c) => ({ folder: c.folder, slug: c.slug, lessonFiles: c.lessonFiles }));
}

/** Builds the group plans: role id, courses, and handoff targets from shared lessons. */
export function buildGroupPlans(root: string = DEFAULT_CURRICULUM_ROOT): GroupPlan[] {
  const courses = readCourses(root);
  const slugToGroup = new Map<string, string>();
  for (const c of courses) slugToGroup.set(c.slug, c.group);

  const edges = new Map<string, Set<string>>();
  for (const c of courses) {
    for (const slugs of c.lessonCourseSlugs) {
      const groups = [...new Set(slugs.map((s) => slugToGroup.get(s)).filter((g): g is string => !!g))];
      for (const a of groups) {
        for (const b of groups) {
          if (a === b) continue;
          const set = edges.get(a) ?? new Set<string>();
          set.add(verticalAssistantRoleId(SERVICE_GROUPS[b].slug));
          edges.set(a, set);
        }
      }
    }
  }

  const plans: GroupPlan[] = [];
  for (const [groupName, persona] of Object.entries(SERVICE_GROUPS)) {
    const members = courses.filter((c) => c.group === groupName);
    if (members.length === 0) continue;
    plans.push({
      roleId: verticalAssistantRoleId(persona.slug),
      groupSlug: persona.slug,
      groupName: persona.title,
      verticals: persona.verticals,
      courses: members,
      handoffTo: [...(edges.get(groupName) ?? [])].sort(),
    });
  }
  return plans;
}

/** Returns one RoleInput per service group, ready for validateRoleDefinition. Writes nothing. */
export function generateAssistantRoles(root: string = DEFAULT_CURRICULUM_ROOT): RoleInput[] {
  return buildGroupPlans(root).map((plan) => {
    const courses: CourseScopeItem[] = plan.courses.map((c) => ({ slug: c.slug, title: c.title }));
    return verticalAssistantRole({
      verticalSlug: plan.groupSlug,
      verticalTitle: plan.groupName,
      verticals: plan.verticals,
      courses,
      handoffTo: plan.handoffTo,
    });
  });
}

interface LessonFile {
  id: string;
  body: Record<string, unknown>;
}

/** Indexes every lesson file under courses/ and shared/ by lesson id. */
function indexLessonFiles(root: string): Map<string, LessonFile> {
  const index = new Map<string, LessonFile>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name.endsWith(".json") && name !== SHARED_STUB) {
        const body = readJson(path) as Record<string, unknown>;
        if (typeof body.id !== "string") continue;
        if (index.has(body.id)) throw new Error(`duplicate lesson id "${body.id}" at ${path}`);
        index.set(body.id, { id: body.id, body });
      }
    }
  };
  walk(join(root, "courses"));
  walk(join(root, "shared"));
  return index;
}

/** Business-field registry keys, "group.field", from business-lesson-fields.json. */
function businessRegistryKeys(root: string): Set<string> {
  const registry = readJson(join(root, "business-lesson-fields.json")) as {
    groups: Record<string, string[]>;
  };
  const keys = new Set<string>();
  for (const [group, fields] of Object.entries(registry.groups)) {
    for (const field of fields) keys.add(`${group}.${field}`);
  }
  return keys;
}

/** Owner's level file. The layer column defines the tier; the level column is informational. */
export const DEFAULT_LEVELS_CSV =
  (process.env.LESSON_LEVELS_CSV && process.env.LESSON_LEVELS_CSV.trim()) ||
  "/mnt/user-data/uploads/333cbb0b-ALL-LESSON-LEVELS.csv";

const LEVEL_HEADER = "course_slug,lesson_id,title,layer,level,has_written_content";

/** Layers in precedence order, used to break ties when an id has rows with more than one layer. */
const LAYER_ORDER: readonly string[] = ["base", "group", "business", "high-risk"];

export interface LevelRow {
  course: string;
  lessonId: string;
  title: string;
  layer: string;
  level: string;
  hasWrittenContent: string;
}

/**
 * Parses the level file. Some titles contain unquoted commas, so each row takes the first
 * two fields from the left and the last three from the right; the title is whatever is left.
 */
export function parseLevelRows(text: string): LevelRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("level file is empty");
  if (lines[0].trim() !== LEVEL_HEADER) throw new Error(`unexpected level file header: ${lines[0].trim()}`);
  return lines.slice(1).map((line) => {
    const p = line.split(",");
    if (p.length < 6) throw new Error(`level row has fewer than 6 fields: ${line.slice(0, 80)}`);
    return {
      course: p[0].trim(),
      lessonId: p[1].trim(),
      title: p.slice(2, -3).join(",").trim(),
      layer: p[p.length - 3].trim(),
      level: p[p.length - 2].trim(),
      hasWrittenContent: p[p.length - 1].trim(),
    };
  });
}

/** Resolves the level file from ACADEMY_LEVELS_CSV, or the default. Throws if absent. */
export function resolveLevelsCsv(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.ACADEMY_LEVELS_CSV ?? DEFAULT_LEVELS_CSV;
  if (!existsSync(path)) throw new Error(`level file not found: ${path}`);
  return path;
}

/**
 * Builds the tier map and lesson check ids. Read only.
 *   base          lessons with layer base (any course)
 *   groupLessons  lessons with layer group, under the service group of the course row
 *   courseLessons lessons with layer business or high-risk, under that course
 * A lesson id with rows in more than one layer takes its most frequent layer (ties by LAYER_ORDER).
 */
export function buildTierMap(
  root: string = DEFAULT_CURRICULUM_ROOT,
  levelsCsv: string = resolveLevelsCsv(),
): TierBuild {
  const modules = readJson(join(root, "structure", "COURSES-MODULES.json")) as {
    courses: { slug: string; group: string }[];
  };
  const courseGroup: Record<string, string> = {};
  for (const c of modules.courses) courseGroup[c.slug] = c.group;

  const rows = parseLevelRows(readFileSync(levelsCsv, "utf8"));
  for (const row of rows) {
    if (!(row.course in courseGroup)) throw new Error(`level file names unknown course "${row.course}"`);
    if (!LAYER_ORDER.includes(row.layer)) throw new Error(`lesson ${row.lessonId} has unknown layer "${row.layer}"`);
  }

  const layerCounts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const counts = layerCounts.get(row.lessonId) ?? new Map<string, number>();
    counts.set(row.layer, (counts.get(row.layer) ?? 0) + 1);
    layerCounts.set(row.lessonId, counts);
  }
  const layerOf = new Map<string, string>();
  const layerConflicts: string[] = [];
  for (const [id, counts] of layerCounts) {
    if (counts.size > 1) layerConflicts.push(id);
    const best = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || LAYER_ORDER.indexOf(a[0]) - LAYER_ORDER.indexOf(b[0]),
    )[0][0];
    layerOf.set(id, best);
  }

  const base = new Set<string>();
  const groupSets: Record<string, Set<string>> = {};
  const courseSets: Record<string, Set<string>> = {};
  const addTo = (bucket: Record<string, Set<string>>, key: string, id: string): void => {
    (bucket[key] ??= new Set()).add(id);
  };
  for (const row of rows) {
    const layer = layerOf.get(row.lessonId)!;
    if (layer === "base") base.add(row.lessonId);
    else if (layer === "group") addTo(groupSets, courseGroup[row.course], row.lessonId);
    else addTo(courseSets, row.course, row.lessonId);
  }

  const groupNames = [...new Set(Object.values(courseGroup))].sort();
  const groupLessons: Record<string, string[]> = {};
  for (const g of groupNames) {
    groupLessons[g] = [...(groupSets[g] ?? [])].filter((id) => !base.has(id)).sort();
  }
  const allGroupIds = new Set(Object.values(groupLessons).flat());
  const courseLessons: Record<string, string[]> = {};
  for (const slug of Object.keys(courseGroup).sort()) {
    courseLessons[slug] = [...(courseSets[slug] ?? [])]
      .filter((id) => !base.has(id) && !allGroupIds.has(id))
      .sort();
  }

  const multiGroupLessons = [...allGroupIds].filter((id) =>
    groupNames.filter((g) => groupLessons[g].includes(id)).length > 1,
  ).sort();

  const index = indexLessonFiles(root);
  const listed = new Set<string>([...base, ...allGroupIds, ...Object.values(courseLessons).flat()]);
  const missingFiles = [...listed].filter((id) => !index.has(id)).sort();

  const registry = businessRegistryKeys(root);
  const courseFields: Record<string, string[]> = {};
  for (const slug of Object.keys(courseGroup).sort()) {
    const keys = new Set<string>();
    for (const id of courseLessons[slug]) {
      const file = index.get(id);
      if (!file) continue;
      for (const match of JSON.stringify(file.body).matchAll(/\{\{business:([a-z_]+\.[a-z_]+)\}\}/g)) {
        if (registry.has(match[1])) keys.add(match[1]);
      }
    }
    courseFields[slug] = [...keys].sort();
  }

  const lessonCheckIds: Record<string, string[]> = {};
  for (const id of listed) {
    const file = index.get(id);
    if (!file) continue;
    const checks = (file.body.knowledgeChecks as { id: string }[] | undefined) ?? [];
    lessonCheckIds[id] = checks.map((check) => check.id);
  }

  const idsPerLayer: Record<string, number> = {};
  for (const layer of LAYER_ORDER) idsPerLayer[layer] = [...layerOf.values()].filter((l) => l === layer).length;

  const tierMap: TierMap = {
    base: [...base].sort(),
    groupLessons,
    courseLessons,
    courseGroup,
    courseFields,
  };
  return { tierMap, lessonCheckIds, missingFiles, layerConflicts, multiGroupLessons, idsPerLayer, rowCount: rows.length };
}

/** Resolves the curriculum root from ACADEMY_CURRICULUM_ROOT, or the default. Throws if absent. */
export function resolveCurriculumRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.ACADEMY_CURRICULUM_ROOT ?? DEFAULT_CURRICULUM_ROOT;
  if (!existsSync(join(root, "courses"))) throw new Error(`curriculum root not found: ${root}`);
  return root;
}

/** Tier map and lesson check ids for the configured LMS curriculum. Built at import time. */
export const TIER_BUILD: TierBuild = buildTierMap(resolveCurriculumRoot());

/** Tier map exported for the knowledge policy. */
export const TIER_MAP: TierMap = TIER_BUILD.tierMap;

/** Knowledge-check ids per lesson id, for the pass rule. */
export const LESSON_CHECK_IDS: Record<string, string[]> = TIER_BUILD.lessonCheckIds;
