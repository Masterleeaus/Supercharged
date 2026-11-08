/**
 * Tests for server/workforce/portfolio/registry.ts. Uses an in-memory registry with a fixed clock and a
 * sequential UUID fake, so no database, network or provider is touched.
 * Run: node --test --experimental-transform-types tests/workforce/portfolio-registry.test.mjs
 */
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolioRegistry, canAct } from '../../server/workforce/portfolio/registry.ts';

const COMPANY = 'company-alpha';
const OTHER_COMPANY = 'company-beta';
const OPERATOR = 'operator-1';
const SERVICE = 'svc-backup';
const STRANGER = 'operator-9';
const T0 = 1_000_000;
const EXPIRES = T0 + 10_000;

function makeRegistry() {
  let now = T0;
  let n = 0;
  const reg = createPortfolioRegistry({
    now: () => now,
    newId: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    },
  });
  return { reg, setNow: (v) => { now = v; } };
}

function setup() {
  const h = makeRegistry();
  const reg = h.reg;
  const reg1 = reg.registerBusiness(COMPANY, {
    managingOperatorId: OPERATOR,
    agreementId: 'agreement-1',
    agreementScope: ['booking.update', 'system.restart'],
    delegatedServiceAccounts: [SERVICE],
  });
  assert.equal(reg1.ok, true);
  const businessId = reg1.value.businessId;
  const grant = reg.grantAccess(COMPANY, businessId, {
    categories: ['booking.update'],
    expiresAt: EXPIRES,
    grantedBy: 'customer-1',
  });
  assert.equal(grant.ok, true);
  return { ...h, reg, businessId, grantId: grant.value.grantId };
}

function assertRefused(decision) {
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'refused');
  assert.equal(decision.audit.outcome, 'refused');
  return decision.audit.detail;
}

test('active business, in-scope category, live grant and managing operator is allowed', () => {
  const { reg, businessId, setNow } = setup();
  setNow(T0 + 1);
  const decision = reg.checkAccess(COMPANY, businessId, OPERATOR, 'booking.update', T0 + 1);
  assert.deepEqual(decision, { allowed: true, reason: null, audit: null });
});

test('delegated service account on the list is allowed', () => {
  const { reg, businessId } = setup();
  const decision = reg.checkAccess(COMPANY, businessId, SERVICE, 'booking.update', T0 + 1);
  assert.equal(decision.allowed, true);
});

test('pure canAct accepts a record from getBusiness with the spec argument order', () => {
  const { reg, businessId } = setup();
  const record = reg.getBusiness(COMPANY, businessId).value;
  assert.equal(canAct(record, OPERATOR, 'booking.update', T0 + 1, COMPANY).allowed, true);
});

test('out-of-scope category is refused even with an operator actor', () => {
  const { reg, businessId } = setup();
  const decision = reg.checkAccess(COMPANY, businessId, OPERATOR, 'billing.charge', T0 + 1);
  assert.equal(assertRefused(decision), 'category_out_of_scope');
});

test('expired grant is refused', () => {
  const { reg, businessId } = setup();
  const decision = reg.checkAccess(COMPANY, businessId, OPERATOR, 'booking.update', EXPIRES);
  assert.equal(assertRefused(decision), 'grant_expired');
});

test('revoked grant is refused and the revocation returns an audit entry', () => {
  const { reg, businessId, grantId } = setup();
  const revoke = reg.revokeAccess(COMPANY, businessId, grantId);
  assert.equal(revoke.ok, true);
  assert.equal(revoke.audit.event, 'grant_revoked');
  assert.equal(revoke.audit.outcome, 'applied');
  assert.equal(revoke.audit.grantId, grantId);

  const decision = reg.checkAccess(COMPANY, businessId, OPERATOR, 'booking.update', T0 + 1);
  assert.equal(assertRefused(decision), 'grant_revoked');
});

test('a second live grant still allows the action after the first is revoked', () => {
  const { reg, businessId, grantId } = setup();
  reg.grantAccess(COMPANY, businessId, { categories: ['booking.update'], expiresAt: EXPIRES, grantedBy: 'customer-1' });
  reg.revokeAccess(COMPANY, businessId, grantId);
  assert.equal(reg.checkAccess(COMPANY, businessId, OPERATOR, 'booking.update', T0 + 1).allowed, true);
});

test('suspended business is refused', () => {
  const { reg, businessId } = setup();
  const suspend = reg.suspend(COMPANY, businessId);
  assert.equal(suspend.ok, true);
  assert.equal(suspend.audit.event, 'business_suspended');
  const decision = reg.checkAccess(COMPANY, businessId, OPERATOR, 'booking.update', T0 + 1);
  assert.equal(assertRefused(decision), 'business_suspended');
});

test('ended agreement is refused and cannot be suspended or ended again', () => {
  const { reg, businessId } = setup();
  assert.equal(reg.endAgreement(COMPANY, businessId).ok, true);
  const decision = reg.checkAccess(COMPANY, businessId, OPERATOR, 'booking.update', T0 + 1);
  assert.equal(assertRefused(decision), 'agreement_ended');
  assert.equal(reg.suspend(COMPANY, businessId).ok, false);
  assert.equal(reg.endAgreement(COMPANY, businessId).audit.detail, 'invalid_transition');
});

test('wrong company is refused for every lookup and mutation, and the record is untouched', () => {
  const { reg, businessId } = setup();
  assert.equal(assertRefused(reg.checkAccess(OTHER_COMPANY, businessId, OPERATOR, 'booking.update', T0 + 1)), 'wrong_company');
  assert.equal(reg.getBusiness(OTHER_COMPANY, businessId).ok, false);
  assert.equal(reg.getBusiness(OTHER_COMPANY, businessId).audit.detail, 'wrong_company');
  assert.equal(reg.suspend(OTHER_COMPANY, businessId).ok, false);
  assert.equal(reg.endAgreement(OTHER_COMPANY, businessId).ok, false);
  const grant = reg.grantAccess(OTHER_COMPANY, businessId, { categories: ['booking.update'], expiresAt: EXPIRES, grantedBy: 'x' });
  assert.equal(grant.ok, false);
  assert.equal(grant.audit.detail, 'wrong_company');
  assert.equal(reg.getBusiness(COMPANY, businessId).value.status, 'active');
});

test('wrong company is refused by the pure canAct even when the record is valid', () => {
  const { reg, businessId } = setup();
  const record = reg.getBusiness(COMPANY, businessId).value;
  assert.equal(assertRefused(canAct(record, OPERATOR, 'booking.update', T0 + 1, OTHER_COMPANY)), 'wrong_company');
});

test('unknown actor is refused', () => {
  const { reg, businessId } = setup();
  const decision = reg.checkAccess(COMPANY, businessId, STRANGER, 'booking.update', T0 + 1);
  assert.equal(assertRefused(decision), 'actor_not_authorised');
});

test('unknown business id is refused with the same generic reason', () => {
  const { reg } = setup();
  const decision = reg.checkAccess(COMPANY, '11111111-1111-4111-8111-111111111111', OPERATOR, 'booking.update', T0 + 1);
  assert.equal(assertRefused(decision), 'unknown_business');
});

test('missing or malformed fields are refused', () => {
  const { reg, businessId } = setup();
  const record = reg.getBusiness(COMPANY, businessId).value;

  assert.equal(assertRefused(canAct(record, OPERATOR, 'booking.update', T0 + 1, undefined)), 'missing_company');
  assert.equal(assertRefused(canAct(record, OPERATOR, 'booking.update', T0 + 1, '   ')), 'missing_company');
  assert.equal(assertRefused(canAct(null, OPERATOR, 'booking.update', T0 + 1, COMPANY)), 'missing_business');
  assert.equal(assertRefused(canAct(undefined, OPERATOR, 'booking.update', T0 + 1, COMPANY)), 'missing_business');
  assert.equal(assertRefused(canAct(record, '', 'booking.update', T0 + 1, COMPANY)), 'missing_actor');
  assert.equal(assertRefused(canAct(record, OPERATOR, undefined, T0 + 1, COMPANY)), 'missing_category');
  assert.equal(assertRefused(canAct(record, OPERATOR, 'booking.update', Number.NaN, COMPANY)), 'invalid_time');
  assert.equal(assertRefused(canAct(record, OPERATOR, 'booking.update', undefined, COMPANY)), 'invalid_time');

  const { agreementId: _omitted, ...noAgreement } = record;
  assert.equal(assertRefused(canAct(noAgreement, OPERATOR, 'booking.update', T0 + 1, COMPANY)), 'invalid_record');

  const noGrants = { ...record, grants: undefined };
  assert.equal(assertRefused(canAct(noGrants, OPERATOR, 'booking.update', T0 + 1, COMPANY)), 'invalid_record');

  const noBusinessId = reg.checkAccess(COMPANY, undefined, OPERATOR, 'booking.update', T0 + 1);
  assert.equal(assertRefused(noBusinessId), 'missing_business_id');
});

test('registration refuses missing fields and does not create a record', () => {
  const { reg } = setup();
  const noAgreementId = reg.registerBusiness(COMPANY, { managingOperatorId: OPERATOR, agreementScope: ['booking.update'] });
  assert.equal(noAgreementId.ok, false);
  const emptyScope = reg.registerBusiness(COMPANY, { managingOperatorId: OPERATOR, agreementId: 'a', agreementScope: [] });
  assert.equal(emptyScope.audit.detail, 'missing_input');
  const noCompany = reg.registerBusiness(undefined, { managingOperatorId: OPERATOR, agreementId: 'a', agreementScope: ['x'] });
  assert.equal(noCompany.audit.detail, 'missing_company');
});

test('registration uses the session company and ignores any companyId in the input', () => {
  const { reg } = setup();
  const created = reg.registerBusiness(COMPANY, {
    managingOperatorId: OPERATOR,
    agreementId: 'agreement-2',
    agreementScope: ['system.restart'],
    companyId: OTHER_COMPANY,
  });
  assert.equal(created.ok, true);
  assert.equal(created.value.companyId, COMPANY);
  assert.equal(reg.getBusiness(OTHER_COMPANY, created.value.businessId).ok, false);
});

test('invalid and duplicate generated ids are refused', () => {
  const bad = createPortfolioRegistry({ now: () => T0, newId: () => 'nope' });
  const r1 = bad.registerBusiness(COMPANY, { managingOperatorId: OPERATOR, agreementId: 'a', agreementScope: ['x'] });
  assert.equal(r1.audit.detail, 'invalid_id');

  const fixed = '22222222-2222-4222-8222-222222222222';
  const dup = createPortfolioRegistry({ now: () => T0, newId: () => fixed });
  assert.equal(dup.registerBusiness(COMPANY, { managingOperatorId: OPERATOR, agreementId: 'a', agreementScope: ['x'] }).ok, true);
  const r2 = dup.registerBusiness(COMPANY, { managingOperatorId: OPERATOR, agreementId: 'a', agreementScope: ['x'] });
  assert.equal(r2.ok, false);
  assert.equal(r2.audit.detail, 'duplicate_id');
});

test('grant creation refuses out-of-scope categories, past expiry and non-active businesses', () => {
  const { reg, businessId } = setup();
  const outOfScope = reg.grantAccess(COMPANY, businessId, { categories: ['billing.charge'], expiresAt: EXPIRES, grantedBy: 'c' });
  assert.equal(outOfScope.audit.detail, 'category_out_of_scope');
  const past = reg.grantAccess(COMPANY, businessId, { categories: ['booking.update'], expiresAt: T0, grantedBy: 'c' });
  assert.equal(past.audit.detail, 'invalid_expiry');
  reg.suspend(COMPANY, businessId);
  const suspended = reg.grantAccess(COMPANY, businessId, { categories: ['booking.update'], expiresAt: EXPIRES, grantedBy: 'c' });
  assert.equal(suspended.audit.detail, 'business_not_active');
});

test('successful grant returns an applied audit entry with the grant id', () => {
  const { reg, businessId } = setup();
  const granted = reg.grantAccess(COMPANY, businessId, { categories: ['system.restart'], expiresAt: EXPIRES, grantedBy: 'customer-1' });
  assert.equal(granted.ok, true);
  assert.equal(granted.audit.event, 'grant_created');
  assert.equal(granted.audit.outcome, 'applied');
  assert.equal(granted.audit.grantId, granted.value.grantId);
  assert.equal(granted.audit.actorId, 'customer-1');
});

test('revoking an unknown or already revoked grant is refused', () => {
  const { reg, businessId, grantId } = setup();
  assert.equal(reg.revokeAccess(COMPANY, businessId, '33333333-3333-4333-8333-333333333333').audit.detail, 'unknown_grant');
  reg.revokeAccess(COMPANY, businessId, grantId);
  const again = reg.revokeAccess(COMPANY, businessId, grantId);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'refused');
  assert.equal(again.audit.detail, 'already_revoked');
});

test('every registry operation refuses a missing company id with the generic reason', () => {
  const { reg, businessId, grantId } = setup();
  const results = [
    reg.getBusiness(undefined, businessId),
    reg.grantAccess(null, businessId, { categories: ['booking.update'], expiresAt: EXPIRES, grantedBy: 'c' }),
    reg.revokeAccess('', businessId, grantId),
    reg.suspend(undefined, businessId),
    reg.endAgreement(undefined, businessId),
    reg.checkAccess(undefined, businessId, OPERATOR, 'booking.update', T0 + 1),
  ];
  for (const r of results) {
    assert.equal(r.ok ?? r.allowed, false);
    assert.equal(r.reason, 'refused');
    assert.equal(r.audit.detail, 'missing_company');
  }
});

test('returned records are copies, so callers cannot change stored state', () => {
  const { reg, businessId } = setup();
  const copy = reg.getBusiness(COMPANY, businessId).value;
  copy.status = 'ended';
  copy.grants.length = 0;
  copy.delegatedServiceAccounts.push(STRANGER);
  const fresh = reg.getBusiness(COMPANY, businessId).value;
  assert.equal(fresh.status, 'active');
  assert.equal(fresh.grants.length, 1);
  assert.equal(fresh.delegatedServiceAccounts.includes(STRANGER), false);
});
