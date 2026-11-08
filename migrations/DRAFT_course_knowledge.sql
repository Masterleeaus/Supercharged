-- DRAFT - NOT APPLIED. Do not run. Not part of the numbered migration sequence and not in the journal.
-- Storage shape for LessonRevision records and their course pins, read by server/workforce/courses/store.
-- The in-memory store is the only implementation today. This file records the shape a database would need.
-- Idempotent (IF NOT EXISTS) so a later re-run is safe.
--
-- Status values match RevisionStatus in server/workforce/courses/knowledge/types.ts. Only PUBLISHED is retrievable by
-- default. DRAFT is retrievable only under the internal draft flag (WORKFORCE_INTERNAL_DRAFT_COURSES).
--
-- OPEN DECISION (unresolved): tenancy rule for platform content.
--   Rule as drafted: company_id IS NULL marks a platform-owned row, and only the platform curriculum may use it.
--   Company-owned rows must carry a company_id.
--   Unresolved: (a) how platform ownership is recorded (a NULL company_id cannot tell a platform row from a
--   company row that lost its key, so a flag column may be needed); (b) the type of company_id (uuid or text,
--   because requireCompanyId accepts positive integers and strings); (c) whether a company may see platform rows
--   that are pinned to its own courses only. The store does not read company_id yet; tenancy is enforced by the
--   learner's ACTIVE enrolment for the same company in canRetrieve.

CREATE TABLE IF NOT EXISTS course_lesson_revisions (
  id           text NOT NULL PRIMARY KEY,
  lesson_id    text NOT NULL,
  status       text NOT NULL,
  content_hash text NOT NULL,
  body         jsonb NOT NULL,
  -- OPEN DECISION: see header. NULL is allowed only for platform-curriculum rows. Type also unresolved (uuid or text).
  company_id   text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_lesson_revisions_status_check
    CHECK (status IN ('DRAFT', 'REVIEW', 'PUBLISHED', 'RETIRED')),
  CONSTRAINT course_lesson_revisions_content_hash_check
    CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  -- One revision per lesson and content. A second id with the same content is a conflict (store rejects it too).
  CONSTRAINT course_lesson_revisions_lesson_hash_key UNIQUE (lesson_id, content_hash)
);

CREATE INDEX IF NOT EXISTS course_lesson_revisions_lesson_id_idx
  ON course_lesson_revisions (lesson_id);

CREATE INDEX IF NOT EXISTS course_lesson_revisions_status_idx
  ON course_lesson_revisions (status);

CREATE TABLE IF NOT EXISTS course_revision_pins (
  revision_id text NOT NULL REFERENCES course_lesson_revisions (id) ON DELETE CASCADE,
  course_id   text NOT NULL,
  vertical_id text NOT NULL,
  PRIMARY KEY (revision_id, course_id)
);

-- Lookup used by listPinnedToCourse: course first, then vertical.
CREATE INDEX IF NOT EXISTS course_revision_pins_course_vertical_idx
  ON course_revision_pins (course_id, vertical_id);
