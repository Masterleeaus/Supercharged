import test from 'node:test';
import { curriculumSkipReason } from './curriculum-guard.mjs';

// The suite body lives in course-roles.suite.mjs. It is loaded only when the curriculum is present.
const skip = curriculumSkipReason();
if (skip) {
  test('course-roles suite', { skip }, () => {});
} else {
  await import('./course-roles.suite.mjs');
}
