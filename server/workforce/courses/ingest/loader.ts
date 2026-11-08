/**
 * Read-only loader: turns the Titan Academy LMS curriculum into LessonRevision records for the
 * course knowledge policy (knowledge/policy.ts). Nothing is written.
 *
 * Rules
 * - Course folders: every folder under courses/ except NON_COURSE_FOLDERS. Folder to course slug
 *   via structure/SLUG-MAP.json folderToCanonical (fallback: the folder name). Course to vertical:
 *   the course's service group in structure/COURSES-MODULES.json, mapped to the group slug
 *   (SERVICE_GROUP_SLUGS, the slug field of generate.ts SERVICE_GROUPS). verticalId = that slug.
 * - Excluded folders: their lesson files are not loaded. Each one is listed in `skipped`
 *   with reason 'excluded-folder'.
 * - Shared lessons: every lesson file under shared/. Each is emitted ONCE. Its course pins are the
 *   union of (a) known course slugs in its own courseSlugs and (b) every course whose
 *   courses/<folder>/SHARED-REFERENCES.json lists its id. The union is a decision: the owner brief
 *   asks for referencing courses, and the lesson files carry their own courseSlugs.
 * - Course pins: one CourseRef per pinned course, courseId = canonical course slug (the id that
 *   enrolments carry), sorted.
 * - A lesson with no known course pin is skipped with reason 'no-course-pin'. Unknown course slugs
 *   are dropped from the pins and listed in the report.
 * - Status: DRAFT and PUBLISHED map to themselves. Any other status string is kept literally.
 * - contentHash: sha256 (hex) of the canonical JSON of the whole lesson body (keys sorted,
 *   no whitespace). id: `${lessonId}-${contentHash.slice(0, 12)}`, which must match the store's
 *   id rule (letters, digits, underscore, hyphen). body is not changed.
 * - Malformed JSON, an unknown course folder, an unknown service group, or a duplicate lesson id
 *   throws. Those are curriculum integrity errors and are not skipped.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { CourseRef, LessonRevision, RevisionStatus } from "../knowledge/types.ts";

/** Mirrors NON_COURSE_FOLDERS in ../generate.ts. The smoke test checks the two are equal. */
export const NON_COURSE_FOLDERS: readonly string[] = ["high-risk", "high-risk-licence-addon"];

/**
 * Mirrors the slug field of SERVICE_GROUPS in ../generate.ts. The smoke test checks the two are equal.
 * Keys are the LMS service group names in structure/COURSES-MODULES.json.
 */
export const SERVICE_GROUP_SLUGS: Readonly<Record<string, string>> = {
  "Cleaning & Hygiene": "cleaning-and-hygiene",
  "Specialist hygiene": "specialist-hygiene",
  "Exterior, height & access": "exterior-height-access",
  Aquatic: "aquatic",
  "Outdoor & garden": "outdoor-and-garden",
  "Property & trades": "property-and-trades",
  "Personal, fitness & pet": "personal-fitness-and-pet",
};

const SHARED_REFERENCES = "SHARED-REFERENCES.json";
const LEVEL_HEADER = "course_slug,lesson_id,title,layer,level,has_written_content";

export type SkipReason = "excluded-folder" | "no-course-pin" | "invalid-lesson" | "referenced-but-missing";

export interface SkippedLesson {
  /** Path relative to the curriculum root. null when no lesson file exists. */
  file: string | null;
  lessonId: string | null;
  reason: SkipReason;
  detail: string;
}

export interface IngestReport {
  /** Lesson JSON files walked (course folders, including excluded ones, and shared/). */
  lessons: number;
  /** Revisions emitted. */
  revisions: number;
  /** Lesson files that were not emitted, with a reason. revisions + skipped-with-file === lessons. */
  skippedLessonFiles: number;
  distinctStatuses: string[];
  statusCounts: Record<string, number>;
  /** Skipped lessons with reason 'no-course-pin'. */
  noCoursePin: number;
  /** Emitted revisions read from shared/. */
  sharedRevisions: number;
  /** Shared revisions pinned to at least one course through a SHARED-REFERENCES.json entry. */
  sharedPinnedByReference: number;
  /** Course slugs named in a lesson's courseSlugs that are not in COURSES-MODULES.json. Dropped from pins. */
  unknownCourseSlugs: { lessonId: string; slug: string }[];
  /** A course's SHARED-REFERENCES.json lists a lesson whose own courseSlugs does not name that course. */
  referenceNotInCourseSlugs: { lessonId: string; courseId: string }[];
  /** Lesson ids in the level file that match no lesson file in the curriculum. */
  unmatchedLevelIds: string[];
}

export interface IngestResult {
  revisions: LessonRevision[];
  skipped: SkippedLesson[];
  report: IngestReport;
}

interface Candidate {
  file: string;
  id: string;
  body: Record<string, unknown>;
  source: "course" | "shared";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** Canonical JSON: object keys sorted at every depth, no whitespace. Array order is kept. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** sha256 hex of the canonical JSON of a lesson body. */
export function lessonContentHash(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

/** DRAFT and PUBLISHED map to themselves. Any other value is kept literally. */
/** Statuses the revision table's CHECK constraint accepts (DRAFT_course_knowledge.sql). */
export const KNOWN_REVISION_STATUSES: readonly string[] = ["DRAFT", "REVIEW", "PUBLISHED", "RETIRED"];

/** Lesson status to revision status. Unknown values are skipped by the loader, not passed through. */
export function mapRevisionStatus(raw: string): RevisionStatus {
  return raw;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot parse ${path}: ${(err as Error).message}`);
  }
}

/** All .json files under dir, recursively, sorted by path. SHARED-REFERENCES.json is excluded. */
function listLessonFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".json") && name !== SHARED_REFERENCES) out.push(path);
    }
  };
  walk(dir);
  return out;
}

/** Lesson ids from the second column of the level file. */
export function readLevelLessonIds(levelsCsv: string): string[] {
  if (!levelsCsv) throw new Error("levelsCsv path is required");
  if (!existsSync(levelsCsv)) throw new Error(`level file not found: ${levelsCsv}`);
  const lines = readFileSync(levelsCsv, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("level file is empty");
  if (lines[0].trim() !== LEVEL_HEADER) throw new Error(`unexpected level file header: ${lines[0].trim()}`);
  return lines.slice(1).map((line) => (line.split(",")[1] ?? "").trim()).filter((id) => id.length > 0);
}

/**
 * Loads every lesson revision from the curriculum root. Read only.
 * @param root the curriculum directory (contains courses/, shared/, structure/)
 * @param levelsCsv the owner's level file, used only to report level ids with no lesson file
 */
export function loadLessonRevisions(root: string, levelsCsv: string): IngestResult {
  const modules = readJson(join(root, "structure", "COURSES-MODULES.json")) as {
    courses: { slug: string; group: string }[];
  };
  const slugMap = readJson(join(root, "structure", "SLUG-MAP.json")) as {
    folderToCanonical?: Record<string, string>;
  };
  const folderToCanonical = slugMap.folderToCanonical ?? {};

  const courseVertical = new Map<string, string>();
  for (const course of modules.courses) {
    const vertical = SERVICE_GROUP_SLUGS[course.group];
    if (!vertical) throw new Error(`service group "${course.group}" has no vertical mapping`);
    courseVertical.set(course.slug, vertical);
  }

  const skipped: SkippedLesson[] = [];
  const candidates: Candidate[] = [];
  const allIds = new Map<string, string>(); // every lesson id walked, excluded or not, to file
  const referencedBy = new Map<string, Set<string>>(); // lesson id to course slugs
  let lessonFiles = 0;

  const consider = (abs: string, source: "course" | "shared", excludedFolder: string | null): void => {
    lessonFiles += 1;
    const file = relative(root, abs);
    const body = readJson(abs);
    const id = isRecord(body) && typeof body.id === "string" ? body.id : null;
    if (id !== null) {
      const first = allIds.get(id);
      if (first !== undefined) throw new Error(`duplicate lesson id "${id}" at ${file} and ${first}`);
      allIds.set(id, file);
    }
    if (excludedFolder !== null) {
      skipped.push({
        file,
        lessonId: id,
        reason: "excluded-folder",
        detail: `folder ${excludedFolder} is not an approved course (NON_COURSE_FOLDERS)`,
      });
      return;
    }
    if (!isRecord(body) || id === null) {
      skipped.push({ file, lessonId: null, reason: "invalid-lesson", detail: "no string id" });
      return;
    }
    if (typeof body.status !== "string") {
      skipped.push({ file, lessonId: id, reason: "invalid-lesson", detail: "no string status" });
      return;
    }
    candidates.push({ file, id, body, source });
  };

  const coursesDir = join(root, "courses");
  if (!existsSync(coursesDir)) throw new Error(`curriculum root has no courses/: ${root}`);
  for (const folder of readdirSync(coursesDir).sort()) {
    const dir = join(coursesDir, folder);
    if (!statSync(dir).isDirectory()) continue;
    const excluded = NON_COURSE_FOLDERS.includes(folder);
    const slug = folderToCanonical[folder] ?? folder;
    if (!excluded && !courseVertical.has(slug)) {
      throw new Error(`course folder "${folder}" has no entry in COURSES-MODULES.json`);
    }
    const refsPath = join(dir, SHARED_REFERENCES);
    if (!excluded && existsSync(refsPath)) {
      const refs = readJson(refsPath) as { sharedLessonIds?: unknown };
      for (const id of Array.isArray(refs.sharedLessonIds) ? refs.sharedLessonIds : []) {
        if (typeof id !== "string") continue;
        const set = referencedBy.get(id) ?? new Set<string>();
        set.add(slug);
        referencedBy.set(id, set);
      }
    }
    for (const abs of listLessonFiles(dir)) consider(abs, "course", excluded ? folder : null);
  }

  const sharedDir = join(root, "shared");
  if (existsSync(sharedDir)) {
    for (const abs of listLessonFiles(sharedDir)) consider(abs, "shared", null);
  }

  const revisions: LessonRevision[] = [];
  const unknownCourseSlugs: IngestReport["unknownCourseSlugs"] = [];
  const referenceNotInCourseSlugs: IngestReport["referenceNotInCourseSlugs"] = [];
  let sharedRevisions = 0;
  let sharedPinnedByReference = 0;

  for (const c of candidates) {
    const own = Array.isArray(c.body.courseSlugs)
      ? c.body.courseSlugs.filter((s): s is string => typeof s === "string")
      : [];
    for (const s of own) if (!courseVertical.has(s)) unknownCourseSlugs.push({ lessonId: c.id, slug: s });
    const refs = [...(referencedBy.get(c.id) ?? [])].sort();
    for (const r of refs) if (!own.includes(r)) referenceNotInCourseSlugs.push({ lessonId: c.id, courseId: r });

    const pins = [...new Set([...own.filter((s) => courseVertical.has(s)), ...refs])].sort();
    if (!KNOWN_REVISION_STATUSES.includes(String(c.body.status))) {
      skipped.push({
        file: c.file,
        lessonId: c.id,
        reason: "invalid-lesson",
        detail: `status "${String(c.body.status)}" is not one of ${KNOWN_REVISION_STATUSES.join(", ")}`,
      });
      continue;
    }
    if (pins.length === 0) {
      skipped.push({
        file: c.file,
        lessonId: c.id,
        reason: "no-course-pin",
        detail: `courseSlugs ${JSON.stringify(own)} names no known course and no SHARED-REFERENCES entry pins it`,
      });
      continue;
    }

    const contentHash = lessonContentHash(c.body);
    const courses: CourseRef[] = pins.map((courseId) => ({ courseId, verticalId: courseVertical.get(courseId)! }));
    revisions.push({
      id: `${c.id}-${contentHash.slice(0, 12)}`,
      lessonId: c.id,
      status: mapRevisionStatus(c.body.status as string),
      contentHash,
      courses,
      body: c.body,
    });
    if (c.source === "shared") {
      sharedRevisions += 1;
      if (refs.length > 0) sharedPinnedByReference += 1;
    }
  }

  for (const [lessonId, courseSet] of referencedBy) {
    if (allIds.has(lessonId)) continue;
    skipped.push({
      file: null,
      lessonId,
      reason: "referenced-but-missing",
      detail: `SHARED-REFERENCES lists it for ${[...courseSet].sort().join(", ")} but no lesson file has this id`,
    });
  }

  revisions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const statusCounts: Record<string, number> = {};
  for (const r of revisions) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

  const unmatched = new Set<string>();
  for (const id of readLevelLessonIds(levelsCsv)) if (!allIds.has(id)) unmatched.add(id);

  const report: IngestReport = {
    lessons: lessonFiles,
    revisions: revisions.length,
    skippedLessonFiles: skipped.filter((s) => s.file !== null).length,
    distinctStatuses: Object.keys(statusCounts).sort(),
    statusCounts,
    noCoursePin: skipped.filter((s) => s.reason === "no-course-pin").length,
    sharedRevisions,
    sharedPinnedByReference,
    unknownCourseSlugs,
    referenceNotInCourseSlugs,
    unmatchedLevelIds: [...unmatched].sort(),
  };
  return { revisions, skipped, report };
}
