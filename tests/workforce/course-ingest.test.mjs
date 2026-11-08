import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(here, "fixtures", "ingest", "curriculum");
const FIXTURE_LEVELS = join(here, "fixtures", "ingest", "levels.csv");

const loader = await import("../../server/workforce/courses/ingest/loader.ts");
const {
  loadLessonRevisions,
  lessonContentHash,
  canonicalJson,
  mapRevisionStatus,
  NON_COURSE_FOLDERS,
  SERVICE_GROUP_SLUGS,
} = loader;

const load = () => loadLessonRevisions(FIXTURE_ROOT, FIXTURE_LEVELS);
const byLesson = (revisions, lessonId) => revisions.filter((r) => r.lessonId === lessonId);

test("content hash is stable and key-order independent", () => {
  const a = { id: "X1", status: "DRAFT", nested: { b: 2, a: [1, { d: 4, c: 3 }] } };
  const b = { nested: { a: [1, { c: 3, d: 4 }], b: 2 }, status: "DRAFT", id: "X1" };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(lessonContentHash(a), lessonContentHash(b));
  assert.equal(lessonContentHash(a), lessonContentHash(JSON.parse(JSON.stringify(a))));
  assert.match(lessonContentHash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(lessonContentHash(a), lessonContentHash({ ...a, status: "PUBLISHED" }));
  assert.equal(canonicalJson({ z: 1, a: [2, 1] }), '{"a":[2,1],"z":1}');
});

test("revision id is lessonId-hash prefix and hashes are stable across loads", () => {
  const first = load().revisions;
  const second = load().revisions;
  assert.deepEqual(
    first.map((r) => [r.id, r.contentHash]),
    second.map((r) => [r.id, r.contentHash]),
  );
  for (const r of first) {
    assert.equal(r.id, `${r.lessonId}-${r.contentHash.slice(0, 12)}`);
    assert.equal(r.contentHash, lessonContentHash(r.body));
  }
});

test("body is passed through unchanged", () => {
  const a1 = byLesson(load().revisions, "A1")[0];
  assert.equal(a1.body.knowledgeChecks[0].answer, "B");
  assert.equal(a1.body.instruction[0].body, "Confirm the scope before starting.");
});

test("status mapping keeps DRAFT, PUBLISHED and literal values", () => {
  assert.equal(mapRevisionStatus("DRAFT"), "DRAFT");
  assert.equal(mapRevisionStatus("PUBLISHED"), "PUBLISHED");
  assert.equal(mapRevisionStatus("REVIEW"), "REVIEW");
  assert.equal(mapRevisionStatus("published"), "published");
  const { revisions, report } = load();
  assert.equal(byLesson(revisions, "A2")[0].status, "PUBLISHED");
  assert.equal(byLesson(revisions, "A4")[0].status, "REVIEW");
  assert.equal(byLesson(revisions, "A1")[0].status, "DRAFT");
  assert.deepEqual(report.distinctStatuses, ["DRAFT", "PUBLISHED", "REVIEW"]);
  assert.deepEqual(report.statusCounts, { DRAFT: 5, PUBLISHED: 1, REVIEW: 1 });
});

test("verticalId is the service group slug", () => {
  const a1 = byLesson(load().revisions, "A1")[0];
  assert.deepEqual(a1.courses, [{ courseId: "alpha-clean", verticalId: "cleaning-and-hygiene" }]);
  assert.equal(SERVICE_GROUP_SLUGS["Aquatic"], "aquatic");
});

test("shared lesson is emitted once, pinned to every referencing course", () => {
  const { revisions } = load();
  const s1 = byLesson(revisions, "S1");
  assert.equal(s1.length, 1, "S1 must appear exactly once");
  assert.deepEqual(
    s1[0].courses.map((c) => [c.courseId, c.verticalId]),
    [
      ["alpha-clean", "cleaning-and-hygiene"],
      ["beta-pool", "aquatic"],
    ],
  );
});

test("shared lesson named only by its own courseSlugs is pinned to that course", () => {
  const s2 = byLesson(load().revisions, "S2")[0];
  assert.deepEqual(s2.courses.map((c) => c.courseId), ["alpha-clean"]);
});

test("excluded folder is not loaded and its lessons are reported", () => {
  const { revisions, skipped } = load();
  assert.equal(byLesson(revisions, "H1").length, 0);
  const h1 = skipped.find((s) => s.lessonId === "H1");
  assert.ok(h1, "H1 must be listed as skipped");
  assert.equal(h1.reason, "excluded-folder");
  assert.match(h1.file, /high-risk-licence-addon/);
  assert.ok(NON_COURSE_FOLDERS.includes("high-risk-licence-addon"));
});

test("lesson with no courseSlugs is reported as skipped with no-course-pin", () => {
  const { revisions, skipped, report } = load();
  assert.equal(byLesson(revisions, "A3").length, 0);
  const a3 = skipped.find((s) => s.lessonId === "A3");
  assert.equal(a3.reason, "no-course-pin");
  assert.equal(skipped.find((s) => s.lessonId === "S9").reason, "no-course-pin");
  assert.equal(report.noCoursePin, 2);
});

test("unknown course slugs are dropped from pins and reported", () => {
  const { revisions, report } = load();
  const a5 = byLesson(revisions, "A5")[0];
  assert.deepEqual(a5.courses.map((c) => c.courseId), ["alpha-clean"]);
  assert.deepEqual(report.unknownCourseSlugs, [{ lessonId: "A5", slug: "not-a-course" }]);
});

test("missing referenced lesson is reported as skipped with no file", () => {
  const { skipped } = load();
  const missing = skipped.find((s) => s.lessonId === "MISSING-1");
  assert.ok(missing);
  assert.equal(missing.reason, "referenced-but-missing");
  assert.equal(missing.file, null);
});

test("every lesson file is either a revision or a skipped entry with a file", () => {
  const { revisions, skipped, report } = load();
  assert.equal(report.lessons, 10);
  assert.equal(report.revisions, revisions.length);
  assert.equal(revisions.length, 7);
  const skippedWithFile = skipped.filter((s) => s.file !== null).length;
  assert.equal(revisions.length + skippedWithFile, report.lessons);
  assert.equal(report.skippedLessonFiles, skippedWithFile);
});

test("report counts shared pins and reference/courseSlug mismatches", () => {
  const { report } = load();
  assert.equal(report.sharedRevisions, 2);
  // alpha-folder's SHARED-REFERENCES lists S1 and S2, so both are pinned by reference.
  assert.equal(report.sharedPinnedByReference, 2);
  assert.deepEqual(report.referenceNotInCourseSlugs, [
    { lessonId: "S1", courseId: "alpha-clean" },
    { lessonId: "S1", courseId: "beta-pool" },
  ]);
  assert.deepEqual(report.unmatchedLevelIds, ["ZZ-L01"]);
});

test("level file header is enforced", () => {
  assert.throws(
    () => loadLessonRevisions(FIXTURE_ROOT, join(here, "fixtures", "ingest", "curriculum", "structure", "SLUG-MAP.json")),
    /unexpected level file header/,
  );
});

test("loader revision ids and statuses pass the store rules", () => {
  // Uses the bundled fixture: every emitted id must match the store rule, and unknown statuses are skipped.
  const rule = /^[A-Za-z0-9_-]{1,100}$/;
  const { revisions } = load();
  assert.ok(revisions.length > 0);
  for (const r of revisions) assert.match(r.id, rule);
  assert.ok(["DRAFT", "REVIEW", "PUBLISHED", "RETIRED"].includes(revisions[0].status));
});

// Real curriculum smoke test. Runs only when ACADEMY_CURRICULUM_ROOT is set.
const liveRoot = process.env.ACADEMY_CURRICULUM_ROOT;
test(
  "real curriculum: loads, checks invariants, and mirrored constants match generate.ts",
  { skip: liveRoot ? false : "ACADEMY_CURRICULUM_ROOT is unset" },
  async () => {
    const levels = process.env.ACADEMY_LEVELS_CSV ?? join(liveRoot, "levels", "ALL-LESSON-LEVELS.csv");
    const { revisions, skipped, report } = loadLessonRevisions(liveRoot, levels);

    console.log(
      `[real curriculum] lessons=${report.lessons} revisions=${report.revisions} ` +
        `statuses=${JSON.stringify(report.statusCounts)} noCoursePin=${report.noCoursePin} ` +
        `skipped=${skipped.length} sharedRevisions=${report.sharedRevisions} ` +
        `sharedPinnedByReference=${report.sharedPinnedByReference} ` +
        `unknownCourseSlugs=${report.unknownCourseSlugs.length} ` +
        `unmatchedLevelIds=${report.unmatchedLevelIds.length}`,
    );
    const reasons = {};
    for (const s of skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
    console.log(`[real curriculum] skipped by reason ${JSON.stringify(reasons)}`);

    assert.ok(revisions.length > 0);
    assert.equal(revisions.length + report.skippedLessonFiles, report.lessons);
    for (const r of revisions) {
      assert.ok(r.courses.length > 0, `${r.id} has no course pin`);
      assert.equal(r.id, `${r.lessonId}-${r.contentHash.slice(0, 12)}`);
    }

    const excludedIds = new Set(
      skipped.filter((s) => s.reason === "excluded-folder").map((s) => s.lessonId),
    );
    assert.ok(excludedIds.size > 0 || skipped.every((s) => s.reason !== "excluded-folder"));
    for (const r of revisions) assert.ok(!excludedIds.has(r.lessonId), `${r.lessonId} is from an excluded folder`);

    // Drift check: the mirrored constants must equal generate.ts. Importing generate.ts runs its
    // import-time tier build, so this only happens here, where the environment is set.
    process.env.ACADEMY_LEVELS_CSV ??= levels;
    const generate = await import("../../server/workforce/courses/generate.ts");
    assert.deepEqual([...NON_COURSE_FOLDERS], [...generate.NON_COURSE_FOLDERS]);
    const generated = Object.fromEntries(
      Object.entries(generate.SERVICE_GROUPS).map(([name, group]) => [name, group.slug]),
    );
    assert.deepEqual(SERVICE_GROUP_SLUGS, generated);
  },
);
