/**
 * Tests for server/workforce/runtime/shadow-changes.ts. In-memory store, injected clock and version reader.
 * Run: node --test --experimental-transform-types tests/workforce/shadow-changes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createShadowChanges,
  createMemoryShadowStore,
  mayDecide,
} from '../../server/workforce/runtime/shadow-changes.ts';

const COMPANY = 'co-a';
const OTHER_COMPANY = 'co-b';
const REQUESTER = { agentId: 'agent-1', roleId: 'role-scheduler' };

function harness() {
  const versions = new Map(); // `${company}|${table}|${id}` -> version
  const applied = [];
  let seq = 0;
  let clock = 1000;
  const store = createMemoryShadowStore();
  const apply = async (change, baseVersionMatches) => {
    if (!(await baseVersionMatches())) return 'conflict';
    applied.push(change.id);
    return 'applied';
  };
  const shadow = createShadowChanges({
    store,
    now: () => clock,
    newId: () => `sc-${++seq}`,
    readVersion: async (company, table, id) => versions.get(`${company}|${table}|${id}`) ?? null,
    apply,
  });
  return {
    shadow,
    store,
    applied,
    setVersion: (company, table, id, v) => versions.set(`${company}|${table}|${id}`, v),
    tick: () => (clock += 1),
  };
}

function input(overrides = {}) {
  return {
    companyId: COMPANY,
    runId: 'run-1',
    toolId: 'tool-invoice-update',
    category: 'other',
    targetTable: 'desk_jobs',
    targetId: 'job-7',
    operation: 'update',
    before: { status: 'open' },
    after: { status: 'scheduled' },
    baseVersion: 3,
    requestedBy: REQUESTER,
    ...overrides,
  };
}

/** Creates a pending change and sets the target to the change's base version so the check passes. */
async function pendingChange(h, overrides = {}) {
  const result = await h.shadow.request(input(overrides));
  assert.equal(result.ok, true);
  h.setVersion(COMPANY, 'desk_jobs', 'job-7', 3);
  return result.change;
}

const owner = { kind: 'human', id: 'user-owner', role: 'owner' };
const manager = { kind: 'human', id: 'user-mgr', role: 'manager' };
const staff = { kind: 'human', id: 'user-staff', role: 'staff' };
const otherAgentDifferentRole = { kind: 'agent', agentId: 'agent-2', roleId: 'role-billing' };

test('a pending change is stored and not applied', async () => {
  const h = harness();
  h.setVersion(COMPANY, 'desk_jobs', 'job-7', 3);
  const result = await h.shadow.request(input());
  assert.equal(result.ok, true);
  assert.equal(result.change.status, 'pending');
  assert.equal(result.change.policyVersion, 1);
  assert.equal(h.store.size(), 1);
  assert.deepEqual(h.applied, []);
  const stored = await h.shadow.get(COMPANY, result.change.id);
  assert.equal(stored.status, 'pending');
  assert.deepEqual(stored.before, { status: 'open' });
  assert.deepEqual(stored.after, { status: 'scheduled' });
});

test('an invalid request is refused and stored nothing', async () => {
  const h = harness();
  const bad = await h.shadow.request(input({ category: 'payroll' }));
  assert.deepEqual(bad, { ok: false, reason: 'invalid', detail: 'category' });
  const badInsert = await h.shadow.request(input({ operation: 'insert', before: { a: 1 } }));
  assert.equal(badInsert.ok, false);
  assert.equal(h.store.size(), 0);
});

test('an owner may approve every category', async () => {
  for (const category of ['money', 'customer_send', 'delete', 'other']) {
    const h = harness();
    const change = await pendingChange(h, { category });
    const result = await h.shadow.decide(COMPANY, change.id, owner, 'approve');
    assert.deepEqual(result, { ok: true, status: 'applied' }, category);
    assert.deepEqual(h.applied, [change.id]);
  }
});

test('a manager may approve every category', async () => {
  for (const category of ['money', 'customer_send', 'delete', 'other']) {
    const h = harness();
    const change = await pendingChange(h, { category });
    const result = await h.shadow.decide(COMPANY, change.id, manager, 'approve');
    assert.equal(result.ok, true, category);
  }
});

test('a staff human may not approve any category', async () => {
  const h = harness();
  const change = await pendingChange(h, { category: 'other' });
  assert.deepEqual(await h.shadow.decide(COMPANY, change.id, staff, 'approve'), {
    ok: false,
    reason: 'not_permitted',
  });
  assert.deepEqual(h.applied, []);
});

test('the same agent may not approve its own other change', async () => {
  const h = harness();
  const change = await pendingChange(h, { category: 'other' });
  const same = { kind: 'agent', agentId: REQUESTER.agentId, roleId: REQUESTER.roleId };
  assert.deepEqual(await h.shadow.decide(COMPANY, change.id, same, 'approve'), {
    ok: false,
    reason: 'not_permitted',
  });
});

test('an agent sharing the requester agentId but not roleId is refused for other', async () => {
  assert.equal(
    mayDecide('other', REQUESTER, { kind: 'agent', agentId: REQUESTER.agentId, roleId: 'role-x' }),
    false,
  );
});

test('an agent sharing the requester roleId but not agentId is refused for other', async () => {
  assert.equal(
    mayDecide('other', REQUESTER, { kind: 'agent', agentId: 'agent-9', roleId: REQUESTER.roleId }),
    false,
  );
});

test('a different agent with a different role may approve an other change', async () => {
  const h = harness();
  const change = await pendingChange(h, { category: 'other' });
  const result = await h.shadow.decide(COMPANY, change.id, otherAgentDifferentRole, 'approve');
  assert.deepEqual(result, { ok: true, status: 'applied' });
  const stored = await h.shadow.get(COMPANY, change.id);
  assert.equal(stored.approvedByKind, 'agent');
  assert.equal(stored.approvedById, 'agent-2');
});

test('a different agent is refused for money, customer_send and delete', async () => {
  for (const category of ['money', 'customer_send', 'delete']) {
    const h = harness();
    const change = await pendingChange(h, { category, operation: 'delete', before: { id: 'job-7' }, after: null });
    assert.deepEqual(
      await h.shadow.decide(COMPANY, change.id, otherAgentDifferentRole, 'approve'),
      { ok: false, reason: 'not_permitted' },
      category,
    );
    assert.deepEqual(h.applied, [], category);
    assert.equal((await h.shadow.get(COMPANY, change.id)).status, 'pending', category);
  }
});

test('a version moved since the request is refused as conflict and never applied', async () => {
  const h = harness();
  const change = await pendingChange(h, { category: 'other' });
  h.setVersion(COMPANY, 'desk_jobs', 'job-7', 4);
  assert.deepEqual(await h.shadow.decide(COMPANY, change.id, owner, 'approve'), {
    ok: false,
    reason: 'conflict',
  });
  assert.deepEqual(h.applied, []);
  assert.equal((await h.shadow.get(COMPANY, change.id)).status, 'conflict');
});

test('a version that moves between the pre-check and apply is caught by apply and refused', async () => {
  const h = harness();
  const change = await pendingChange(h, { category: 'other' });
  let seen = 0;
  const shadow = createShadowChanges({
    store: h.store,
    now: () => 2000,
    newId: () => 'unused',
    readVersion: async () => (++seen === 1 ? 3 : 5),
    apply: async (c, check) => {
      if (!(await check())) return 'conflict';
      h.applied.push(c.id);
      return 'applied';
    },
  });
  assert.deepEqual(await shadow.decide(COMPANY, change.id, owner, 'approve'), {
    ok: false,
    reason: 'conflict',
  });
  assert.deepEqual(h.applied, []);
  assert.equal((await h.shadow.get(COMPANY, change.id)).status, 'conflict');
});

test('a rejected change is never applied, even when approval is attempted afterwards', async () => {
  const h = harness();
  const change = await pendingChange(h, { category: 'other' });
  assert.deepEqual(await h.shadow.decide(COMPANY, change.id, owner, 'reject'), { ok: true, status: 'rejected' });
  assert.deepEqual(await h.shadow.decide(COMPANY, change.id, owner, 'approve'), {
    ok: false,
    reason: 'not_pending',
  });
  assert.deepEqual(h.applied, []);
  const stored = await h.shadow.get(COMPANY, change.id);
  assert.equal(stored.status, 'rejected');
  assert.equal(stored.approvedById, 'user-owner');
});

test('an applied change cannot be applied twice', async () => {
  const h = harness();
  const change = await pendingChange(h, { category: 'other' });
  await h.shadow.decide(COMPANY, change.id, owner, 'approve');
  assert.deepEqual(await h.shadow.decide(COMPANY, change.id, manager, 'approve'), {
    ok: false,
    reason: 'not_pending',
  });
  assert.deepEqual(h.applied, [change.id]);
});

test('a change from another company is not visible, decided or applied', async () => {
  const h = harness();
  const change = await pendingChange(h, { category: 'other' });
  assert.equal(await h.shadow.get(OTHER_COMPANY, change.id), null);
  assert.deepEqual(await h.shadow.decide(OTHER_COMPANY, change.id, owner, 'approve'), {
    ok: false,
    reason: 'not_found',
  });
  assert.deepEqual(h.applied, []);
  assert.equal((await h.shadow.get(COMPANY, change.id)).status, 'pending');
});

test('a target version in another company does not satisfy the base-version check', async () => {
  const h = harness();
  const change = await pendingChange(h, { category: 'other' });
  // Same table and id in the other company is at the base version; the requesting company's target has moved.
  h.setVersion(OTHER_COMPANY, 'desk_jobs', 'job-7', 3);
  h.setVersion(COMPANY, 'desk_jobs', 'job-7', 9);
  assert.deepEqual(await h.shadow.decide(COMPANY, change.id, owner, 'approve'), {
    ok: false,
    reason: 'conflict',
  });
  assert.deepEqual(h.applied, []);
});

test('listPending returns only this company pending changes, oldest first', async () => {
  const h = harness();
  const first = await pendingChange(h, { category: 'other' });
  h.tick();
  const second = await pendingChange(h, { category: 'other', targetId: 'job-8' });
  h.setVersion(COMPANY, 'desk_jobs', 'job-8', 3);
  await h.shadow.request(input({ companyId: OTHER_COMPANY, targetId: 'job-9' }));
  const decided = await pendingChange(h, { category: 'other', targetId: 'job-10' });
  assert.equal((await h.shadow.decide(COMPANY, decided.id, owner, 'reject')).ok, true);

  const pending = await h.shadow.listPending(COMPANY);
  assert.deepEqual(pending.map((c) => c.id), [first.id, second.id]);
  assert.ok(pending.every((c) => c.companyId === COMPANY && c.status === 'pending'));
  assert.deepEqual(await h.shadow.listPending(OTHER_COMPANY).then((rows) => rows.length), 1);
});

test('listPending returns nothing for a missing or blank company id', async () => {
  const h = harness();
  await pendingChange(h, { category: 'other' });
  assert.deepEqual(await h.shadow.listPending(''), []);
  assert.deepEqual(await h.shadow.listPending('   '), []);
});

test('an admin may approve every category, the same as owner and manager', async () => {
  const admin = { kind: 'human', id: 'user-admin', role: 'admin' };
  assert.equal(mayDecide('money', REQUESTER, admin), true);
  assert.equal(mayDecide('delete', REQUESTER, admin), true);
  assert.equal(mayDecide('other', REQUESTER, staff), false);
});

test('a table outside the apply allowlist leaves the change pending and runs nothing', async () => {
  const applied = [];
  let seq = 0;
  const store = createMemoryShadowStore();
  const shadow = createShadowChanges({
    store,
    now: () => 1000,
    newId: () => `sc-${++seq}`,
    readVersion: async () => 3,
    canApply: (table) => table !== 'desk_jobs',
    apply: async (change) => {
      applied.push(change.id);
      return 'applied';
    },
  });
  const created = await shadow.request(input());
  assert.equal(created.ok, true);
  assert.deepEqual(await shadow.decide(COMPANY, created.change.id, owner, 'approve'), { ok: false, reason: 'invalid' });
  assert.equal((await shadow.get(COMPANY, created.change.id)).status, 'pending');
  assert.deepEqual(applied, []);
});

/** A service whose apply throws on the first call and succeeds after. The target stays at the base version. */
function flakyService(failures = 1) {
  let seq = 0;
  let calls = 0;
  const store = createMemoryShadowStore();
  const shadow = createShadowChanges({
    store,
    now: () => 1000,
    newId: () => `sc-${++seq}`,
    readVersion: async () => 3,
    apply: async () => {
      calls += 1;
      if (calls <= failures) throw new Error('database unavailable');
      return 'applied';
    },
  });
  return { shadow, store, calls: () => calls };
}

test('an apply that throws leaves the change at approved, and retry re-applies it', async () => {
  const { shadow, calls } = flakyService(1);
  const created = await shadow.request(input());
  await assert.rejects(shadow.decide(COMPANY, created.change.id, owner, 'approve'), /database unavailable/);
  assert.equal((await shadow.get(COMPANY, created.change.id)).status, 'approved');

  const retried = await shadow.retry(COMPANY, created.change.id, manager);
  assert.deepEqual(retried, { ok: true, status: 'applied' });
  assert.equal((await shadow.get(COMPANY, created.change.id)).status, 'applied');
  assert.equal(calls(), 2);
});

test('retry refuses a change that is not at approved, and a staff member', async () => {
  const { shadow, calls } = flakyService(0);
  const pending = await shadow.request(input({ category: 'other' }));
  assert.deepEqual(await shadow.retry(COMPANY, pending.change.id, owner), { ok: false, reason: 'not_pending' });
  assert.equal(calls(), 0);

  const done = await shadow.request(input({ category: 'other', targetId: 'job-11' }));
  await shadow.decide(COMPANY, done.change.id, owner, 'approve');
  assert.deepEqual(await shadow.retry(COMPANY, done.change.id, owner), { ok: false, reason: 'not_pending' });
});

test('retry by a staff member is refused and the change stays approved', async () => {
  const { shadow, calls } = flakyService(1);
  const created = await shadow.request(input());
  await assert.rejects(shadow.decide(COMPANY, created.change.id, owner, 'approve'));
  assert.deepEqual(await shadow.retry(COMPANY, created.change.id, staff), { ok: false, reason: 'not_permitted' });
  assert.equal((await shadow.get(COMPANY, created.change.id)).status, 'approved');
  assert.equal(calls(), 1);
});

test('retry from another company finds nothing', async () => {
  const { shadow } = flakyService(1);
  const created = await shadow.request(input());
  await assert.rejects(shadow.decide(COMPANY, created.change.id, owner, 'approve'));
  assert.deepEqual(await shadow.retry(OTHER_COMPANY, created.change.id, owner), { ok: false, reason: 'not_found' });
  assert.equal((await shadow.get(COMPANY, created.change.id)).status, 'approved');
});

test('retry that finds the target moved reports conflict and stays out of applied', async () => {
  let seq = 0;
  const store = createMemoryShadowStore();
  let version = 3;
  const shadow = createShadowChanges({
    store,
    now: () => 1000,
    newId: () => `sc-${++seq}`,
    readVersion: async () => version,
    apply: async () => {
      throw new Error('transient');
    },
  });
  const created = await shadow.request(input());
  await assert.rejects(shadow.decide(COMPANY, created.change.id, owner, 'approve'));
  version = 4;
  assert.deepEqual(await shadow.retry(COMPANY, created.change.id, owner), { ok: false, reason: 'conflict' });
  assert.equal((await shadow.get(COMPANY, created.change.id)).status, 'conflict');
});
