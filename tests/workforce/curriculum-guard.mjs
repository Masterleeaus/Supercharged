// Shared check for the course suites. They need the Titan Academy LMS curriculum folder and the
// owner's lesson level file, neither of which is in this repo. When either is missing the suites
// are skipped with a message instead of failing at import time.
//
// Where the suites run:
// - The bodies are in course-knowledge.suite.mjs, course-roles.suite.mjs and courses.suite.mjs.
//   Their names do not contain ".test.", so the `npm test` glob (find tests -name '*.test.*')
//   never picks them up directly.
// - The three *.test.mjs wrappers are the only entry point. Each one imports its suite only when
//   curriculumSkipReason() returns null, so a wrapper runs its suite when the curriculum root and
//   level file exist (set ACADEMY_CURRICULUM_ROOT and ACADEMY_LEVELS_CSV, or place them at the
//   default paths below).
// - CI (.github/workflows/pr-checks.yml) does not have the curriculum, so in CI the wrappers skip.
//   The course suites are not covered by CI. Run them locally on a machine with the curriculum.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CURRICULUM_ROOT = '/home/claude/scan10/LMS/lms-main/curriculum';
const DEFAULT_LEVELS_CSV = '/mnt/user-data/uploads/333cbb0b-ALL-LESSON-LEVELS.csv';

/** Returns a skip message when the curriculum or level file is missing, otherwise null. */
export function curriculumSkipReason(env = process.env) {
  const root = env.ACADEMY_CURRICULUM_ROOT ?? DEFAULT_CURRICULUM_ROOT;
  const levels = env.ACADEMY_LEVELS_CSV ?? (env.LESSON_LEVELS_CSV?.trim() || DEFAULT_LEVELS_CSV);
  if (!existsSync(join(root, 'courses'))) {
    return `skipped: LMS curriculum not found at ${root}. Set ACADEMY_CURRICULUM_ROOT to run this suite.`;
  }
  if (!existsSync(levels)) {
    return `skipped: lesson level file not found at ${levels}. Set ACADEMY_LEVELS_CSV to run this suite.`;
  }
  return null;
}
