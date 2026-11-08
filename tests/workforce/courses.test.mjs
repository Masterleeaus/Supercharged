import test from 'node:test';
import { curriculumSkipReason } from './curriculum-guard.mjs';

// The suite body lives in courses.suite.mjs. It is loaded only when the curriculum is present.
const skip = curriculumSkipReason();
if (skip) {
  test('courses suite', { skip }, () => {});
} else {
  await import('./courses.suite.mjs');
}
