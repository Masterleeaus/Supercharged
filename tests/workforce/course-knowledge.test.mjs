import test from 'node:test';
import { curriculumSkipReason } from './curriculum-guard.mjs';

// The suite body lives in course-knowledge.suite.mjs. It is loaded only when the curriculum is present.
const skip = curriculumSkipReason();
if (skip) {
  test('course-knowledge suite', { skip }, () => {});
} else {
  await import('./course-knowledge.suite.mjs');
}
