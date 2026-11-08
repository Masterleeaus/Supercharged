// Internal draft exception to rule 1 (WORKFORCE_INTERNAL_DRAFT_COURSES, default OFF).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRetrieve, internalDraftAccessEnabled } from '../../server/workforce/courses/knowledge/policy.ts';

const ctx = {
  companyId: 'co-1',
  learnerId: 'l-1',
  verticalId: 'cleaning',
  enrolments: [{ courseId: 'c-1', companyId: 'co-1', status: 'ACTIVE' }],
};
const revision = (status, courses = [{ courseId: 'c-1', verticalId: 'cleaning' }]) => ({
  id: 'r-1', lessonId: 'L-1', status, contentHash: 'h', courses, body: {},
});

test('default: a DRAFT revision is denied as not published', () => {
  const d = canRetrieve(ctx, revision('DRAFT'));
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'REVISION_NOT_PUBLISHED');
});

test('flag on: an enrolled DRAFT revision in the vertical is allowed', () => {
  assert.equal(canRetrieve(ctx, revision('DRAFT'), { allowDraftRevisions: true }).allowed, true);
});

test('flag on: REVIEW and RETIRED stay denied', () => {
  for (const status of ['REVIEW', 'RETIRED']) {
    const d = canRetrieve(ctx, revision(status), { allowDraftRevisions: true });
    assert.equal(d.allowed, false, status);
    assert.equal(d.code, 'REVISION_NOT_PUBLISHED', status);
  }
});

test('flag on: DRAFT still needs placement and an active enrolment', () => {
  const noEnrol = { ...ctx, enrolments: [] };
  const d = canRetrieve(noEnrol, revision('DRAFT'), { allowDraftRevisions: true });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'NO_ACTIVE_ENROLMENT');
  const unplaced = canRetrieve(ctx, revision('DRAFT', []), { allowDraftRevisions: true });
  assert.equal(unplaced.code, 'NOT_PLACED_IN_COURSE');
});

test('PUBLISHED is allowed with or without the flag', () => {
  assert.equal(canRetrieve(ctx, revision('PUBLISHED')).allowed, true);
});

test('internalDraftAccessEnabled reads the env var, default off', () => {
  assert.equal(internalDraftAccessEnabled({}), false);
  assert.equal(internalDraftAccessEnabled({ WORKFORCE_INTERNAL_DRAFT_COURSES: '1' }), true);
  assert.equal(internalDraftAccessEnabled({ WORKFORCE_INTERNAL_DRAFT_COURSES: 'off' }), false);
});
