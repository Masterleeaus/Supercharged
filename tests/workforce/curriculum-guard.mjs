// Shared check for the course suites. They need the Titan Academy LMS curriculum folder and the
// owner's lesson level file, neither of which is in this repo. When either is missing the suites
// are skipped with a message instead of failing at import time.
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
