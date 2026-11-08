# Course knowledge policy: port notes

Source: Titan Academy LMS, `/home/claude/scan10/LMS/lms-main` (read only). Paths below are relative to that root.
Backend: `apps/backend/src/modules/`. Schema: `apps/backend/prisma/schema.prisma`.

Scope (current, per the owner's latest decision):
- Vertical limit: each vertical assistant retrieves only lesson content from courses in its own vertical. `LearnerContext.verticalId` is required. Out-of-vertical requests get a friendly redirect that names the vertical to ask. The course-to-vertical grouping is supplied by the caller (the generator agent's grouping of the 45 courses). The Academy has no course-vertical column in the files read. The nearest source is track scope `VERTICAL` at `curriculum/curriculum.routes.ts` L18, which is a track property, not a course property.
- Assessment page guard: the client's page state is untrusted. The assistant refuses to answer only when the server confirms an open assessment (status `in_progress`, for this learner and company). A client claim alone is answered normally, with assessment content withheld.
- Answer keys and assessment answers are never returned, including after the learner has submitted or signed off an assessment. Stripping does not depend on assessment status.

## Progressive tiers (current)

Tiers, per learner, in this order:
- **Tier 0, base.** The lessons of the 'Shared:' modules in `curriculum/structure/COURSES-MODULES.json`. Available to every learner with an ACTIVE enrolment. Code: `unlockedLessonIds`.
- **Tier 1, vertical.** The lessons of the role's service group. Unlocked only after the base tier is passed, and only with an ACTIVE enrolment in a course of that group. Code: `unlockedLessonIds`.
- **Tier 2, course and business.** Lessons of the learner's ACTIVE courses in the group, plus approved business-field values for those courses, scoped to the learner's company. Unlocked only after the vertical tier is passed. Code: `unlockedLessonIds` (lessons) and `approvedBusinessValues` (values).

"Passed" for a tier means every knowledge check on a lesson in that tier has a server-recorded best score at or above 80. A 79 keeps the tier locked. Scores come from the server (`LearnerProgress.bestScores`), never from the client.

Decisions made (for review):
1. **Base count: 184 (owner level file, layer `base`), not 45 and not 104.** The current map is built from `/mnt/user-data/uploads/333cbb0b-ALL-LESSON-LEVELS.csv`, where the `layer` column defines the tier and `level` is informational. `BASE_TIER_LESSON_COUNT = 184` in `types.ts`. Earlier counts (104 from the 'Shared:' modules) are superseded. Layer and level disagree on many rows; the agent reports the six named conflict ids have one layer each, so no reassignment was made. The owner's brief said 45 base lessons. `COURSES-MODULES.json` has 104 distinct lesson ids in its 'Shared:' modules, which matches the coordinator's count. `BASE_TIER_LESSON_COUNT = 104` in `types.ts`, and `validateTierMap` reports any other count. The file also has 12 distinct 'Shared:' module names, not 10, and 43 courses (`meta.courses`), not 45. Both need the owner's confirmation.
2. **A tier with lessons but no knowledge checks cannot be passed (fail closed); a tier with no lessons passes.** Only Personal, fitness and pet has no group lessons in the current map (Specialist hygiene now has 49, Aquatic 6). Failing them closed would lock their course tiers for good, so an empty tier passes, as the agent's `progression.ts` does. A group missing from the map entirely would also count as empty, so `validateTierMap` must flag unknown groups.
3. **Only checked lessons count toward a tier.** A lesson with no check inside a passed tier does not block the tier.
4. **Best attempt counts.** The server's best score per lesson is used, matching the Academy's per-attempt pass (`curriculum/curriculum.routes.ts` L146, 80%).
5. **Tier 1 needs an enrolment in a group course.** A learner enrolled only outside the group cannot unlock group lessons, even after base is passed.
6. **Business keys are a course-to-key map from the generator.** `business-lesson-fields.json` has 56 keys in 13 groups and no course mapping, so `TierMap.courseFields` must come from the course-role generator. Keys are returned only after the vertical tier passes.
7. **Locked content is never quoted or cited.** Passages from a locked lesson, or from another revision, are dropped without a trace. The reply names only the next tier to pass, not the locked lesson.
8. **Tier map wired.** `TIER_MAP` and `LESSON_CHECK_IDS` are exported from `server/workforce/courses/generate.ts` (L330-336) by the course-role agent (a125f26555e8483a9). `real-tiers.ts` binds the real map to the pure policy, which keeps its `roleScope` parameter for fixture tests. The tests import the real map and pass `validateTierMap` with 184 base lessons. The generator's `TierMap` type lives in `progression.ts`, and its shape matches ours.
9. **Lesson scores come from per-check scores.** `lessonScoresFromChecks` takes each lesson's score as the minimum over its checks (`LESSON_CHECK_IDS`), so a lesson passes only when every check is at or above 80. The server supplies per-check best scores.
10. **Aligned with `progression.ts`.** The agent has changed `unlockedTiers` to the owner's order: group lessons open after base passes, course lessons and course business values open after the vertical tier passes. Its `tierPassed([])` returns true for an empty tier, and this policy now does the same (decision 2).

Mapping of the Academy's knowledge-check pass rule: `curriculum/curriculum.routes.ts` L146 (`score / total >= 0.8`) and `PASS6-KNOWLEDGE-CHECKS.md` L6 (passing requires 80%).

## Parity with progression.ts (checked against the real map)

Wiring: `real-tiers.ts` binds TIER_MAP and LESSON_CHECK_IDS from `generate.ts` to the policy. It is separate so that `policy.ts` stays pure, because `generate.ts` reads the curriculum folder when it loads. The pure functions in `policy.ts` keep their `roleScope` parameter so that tests can use small fixture maps. The real map is validated by `REAL_TIER_PROBLEMS`, which is empty.

Real map facts (current): base has 184 lessons, 18 of them without a knowledge check. Group tiers: Cleaning & Hygiene 143 (1 without a check), Specialist hygiene 49, Exterior, height & access 10 (1 without), Aquatic 6, Outdoor & garden 20, Property & trades 23 (1 without), Personal, fitness & pet 0. Every tier still has at least one checked lesson, so the fail-closed case (lessons but no checks) is not triggered. 23 lessons sit in more than one group's tier (for example C19-L01 in Cleaning & Hygiene, Outdoor & garden and Property & trades); the vertical limit cannot separate those, and this needs an owner decision.

Mismatches. In each case the policy is the reference and fails closed where the two differ.

| # | Case | progression.ts | Policy | Result |
|---|------|----------------|--------|--------|
| P1 | Base lessons before base is passed | Was L108 `base ? tierMap.base : []`, which withheld base lessons until base passed. The agent fixed it: lessons now start with `tierMap.base` whenever the learner is enrolled (L108-110). | Base lessons are available to every learner with an active enrolment (owner order). | Fixed in progression.ts. Test: "parity: base failed, both keep base lessons open". |
| P2 | A tier with lessons but no checks | L72-76: `tierPassed([])` is true, so the tier passes. | `tierPassed` requires at least one checked lesson, so the tier stays locked. | Policy stricter. The real map has no such tier. |
| P3 | A tier with no lessons | `tierPassed([])` is true, so the tier passes. | Passes, the same as progression. Covers Personal, fitness and pet in the current map. | Agreed. Test: "parity: the three groups with no lessons". |
| P4 | Unknown service group | L91 throws. | Unlocks base lessons only, and no business keys. | Policy does not throw. Test: "parity: an unknown group". |
| P5 | Enrolment status and company | L94: any enrolled course slug. No status, no company. | Requires `ACTIVE` and the learner's company. | Policy stricter. Test: "parity difference: enrolment without a company match". |
| P6 | Group lessons need a group enrolment | L108-109: group lessons open after base with no enrolment in the group. | Requires an active enrolment in a course of the group. | Policy stricter. Test: "parity difference: group not enrolled". |
| P7 | Check scores | Per-check scores (L72-76). | Per-lesson score is the minimum over its checks (`lessonScoresFromChecks`). | Equivalent, verified in the parity test. |
| P8 | Business values | Filters the server's list by company and APPROVED, for unlocked keys. | Same, and also requires the key to be in the approved registry and excludes keys with duplicate approved rows. | Policy stricter. |

Parity result: with base passed and a group course enrolled, lessons match exactly for both group pass and fail (test: "parity: with base passed and a course in the group enrolled"). Suites: course-knowledge 108 of 108 pass. progression `tests/workforce/courses.test.mjs` 30 of 30 pass.

## Rule-by-rule mapping

| # | Rule | Policy function | Academy file and line |
|---|------|-----------------|-----------------------|
| 1 | Only PUBLISHED revisions | `canRetrieve` | `curriculum/curriculum.routes.ts` L101, L135, L162, L370; `curriculum/curriculum.routes.ts` L94 (outline filter); `templates/template.store.ts` L79; `curriculum/lesson-review.service.ts` L220-232 (only publish path, DRAFT to PUBLISHED); schema L615-626 (`status` default `DRAFT`) |
| 2a | Vertical limit | `canRetrieve`, `guardCourseRequest` | Academy has no course-vertical rule. Track scope `VERTICAL` (`curriculum/curriculum.routes.ts` L18) is the nearest source. This is a new restriction, not a port. |
| 2 | Active enrolment only | `canRetrieve` | `curriculum/curriculum.routes.ts` L88-92 (outline, `status: "ACTIVE"`), L136 (attempts), L373-374 (context route); `templates/template.store.ts` L87; schema L26-30 (`EnrollmentStatus`) |
| 3 | Answer keys and scoring never returned | `stripAssessmentData`, `answerMaterial`, `screenPassageText` | `curriculum/curriculum.routes.ts` L114-127 (`publicLessonBody`), secret set L118, recursive strip L119-126; applied at L94, L377, L450; grading kept server-side L139-147 |
| 4 | No answers to live knowledge-check questions | `guardAssessmentQuestion`, `guardAssessmentPage` | Academy has no in-progress state. Attempts are one atomic POST, `curriculum/curriculum.routes.ts` L129-148. See mismatch 4. |
| 5 | Approved organisation values only | `selectApprovedFieldValues` | `curriculum/business-lesson-fields.ts` L62-64 (key allowlist), L67-73 (APPROVED only); `curriculum/curriculum.routes.ts` L375 (query `status: "APPROVED"`); L359 (retire sets RETIRED); schema L857-874 (`@@unique([organisationId, fieldKey])` L871) |
| 6 | Citations to revision and snapshot | `buildCitations`, `prepareRetrieval` | `curriculum/curriculum.routes.ts` L385-387 (returns `lessonRevisionId`, `contextSnapshotId`, `contentHash`); snapshot created only at L386; scoped detail read L431-454 (learner and org predicates L437; integrity check L451-452) |
| 7 | Passage limits | `limitPassages` (`MAX_PASSAGES` 5, `MAX_PASSAGE_CHARS` 1200) | None in Academy. `curriculum/curriculum.routes.ts` L392-396 limits snapshot list paging (1-100), not retrieval. |

Other mappings:
- Learner-facing refusal messages are friendly redirects (`AgentReply` kind `redirect`), not errors.
- Page guard: `guardAssessmentPage`. Server-confirmed means an open assessment with status `in_progress`, for this learner and company. Assessment kinds are knowledge check and practical. Academy's practical evidence is `curriculum/curriculum.routes.ts` L157-171 and `schema` practical evidence models.

## Mismatches between the Academy backend and these rules

1. **Answer-key stripping is by key name only (curriculum.routes.ts L118-126).** Prose strings are not inspected, so an answer in a summary or instruction string passes through. Keys not in the set (`score`, `scoring`, `points`, `marks`, `passMark`, `threshold`, `weight`, `key`, `correct`, `answers`) also pass through. The policy strips all of these and also withholds passages containing answer-marker wording or the correct option text.
2. **Knowledge-check questions and options reach the learner.** `publicLessonBody` keeps `knowledgeChecks` with `question` and `options`; only `correctIndex`, `explanation` and similar keys are removed (L118). The policy drops knowledge-check subtrees entirely from anything the agent may quote.
3. **Assessment rubric is returned to learners.** `templates/template.service.ts` L54 returns `assessmentRubric: loaded.rubric` in `getLearnerLesson`. That route does not call `publicLessonBody` (`templates/template.routes.ts` L42-44). Rubric levels are scoring data under rule 3, so the policy strips `assessmentRubric`. The Academy route should be fixed.
4. **No in-progress state for knowledge checks.** Attempts are recorded in one POST (`curriculum/curriculum.routes.ts` L129-148), so the server never knows a check is "in progress". Rule 4 can only be enforced if the retrieval layer records open assessments. `guardAssessmentQuestion` acts only on server-confirmed open assessments. The question match is a heuristic (quoted text, check phrases, word overlap). The model layer should add its own classification as a backstop.
5. **Enrolment has no organisation column.** `Enrollment` (schema L250ff) carries `studentId`, `courseId`, `status`. The tenant link is `AcademyTrainingAssignment.organisationId` (schema L771-788). The outline and attempt routes (L88-92, L136) do not check organisation. The context route does (L371). The policy requires an enrolment whose `companyId` matches. The retrieval layer must derive `companyId` from the assignment.
6. **Revision status is a free string.** `AcademyLessonRevision.status` (schema L623) is `String`. Academy only writes `DRAFT` and `PUBLISHED`. `REVIEW` and `RETIRED` are not revision statuses. Review state is derived (`lesson-review.service.ts` L275). The policy's allowlist refuses everything except `PUBLISHED`, including unknown values.
7. **Completed enrolments lose access.** `EnrollmentStatus` includes `COMPLETED` (schema L26-30). Academy's outline and attempt routes also require `ACTIVE`, so the policy matches. This is a product decision to confirm: learners who have finished a course can no longer retrieve its lessons.
8. **Business-value resolver has no company check and leaves unresolved placeholders visible.** `resolveApprovedBusinessFields` (business-lesson-fields.ts L67-73) relies on the caller's query for the company (L375). `resolveLessonText` returns unresolved `{{business:...}}` text unchanged (L78). The policy checks company and approval itself. It excludes keys with more than one approved row, even though the unique index (schema L871) makes that impossible.
9. **Snapshot hash is not the revision hash.** The context route hashes `{revisionId, fields, body}` (L385). The revision hash is `contentHashOf(body)` (`lesson-review.service.ts` L27-28). Citations carry the revision's content hash, which is what `prepareRetrieval` uses. The retrieval layer should record which hash it cites.
10. **Over-blocking.** A passage containing the correct option text is withheld even when that text appears legitimately in lesson prose. This is deliberate (fail closed), but it will hide some valid content. Review on real lessons.
12. **No course-to-vertical mapping in the Academy.** The vertical rule depends on `CourseRef.verticalId`, which the Academy schema does not hold. The caller must supply it from the generator's grouping, and it must match the courses' real identifiers.
11. **Passage limits are new.** Academy has no retrieval passage limit, so `MAX_PASSAGES` and `MAX_PASSAGE_CHARS` are policy choices, not ports.

## Required from the retrieval layer

- Build `LearnerContext.enrolments` from `AcademyTrainingAssignment` joined to enrolments, with `companyId` taken from `organisationId`.
- Build `openAssessments` from server state only. Never copy them from client input.
- Build `LessonRevision.courses` from `AcademyCourseTrack` and `AcademyLessonPlacement` for that exact revision, with `verticalId` for each course from the generator's grouping.
- Set `LearnerContext.verticalId` to the vertical the assistant serves.
- Build candidate passages from `stripAssessmentData(revision.body)`. Pass every passage its `snapshotId`. Create the snapshot with the context route (L364-388) before quoting.
- Build business values from `AcademyBusinessLessonField` for the same company. Use `selectApprovedFieldValues` and substitute them before passages are built.
- Log each reply's citations for audit.
