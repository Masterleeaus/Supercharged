import test from 'node:test';
import assert from 'node:assert/strict';

const { ToolExecutor } = await import('../../server/services/ai-runtime/tools.ts');

const CO_A = 101;
const CO_B = 202;

function makeExecutor({ allowedTools = ['booking.lookup'], handler, audit = [] } = {}) {
  const calls = [];
  const manifest = {
    'booking.lookup': {
      input_schema: { booking_id: 'required' },
      handler: async (params, call) => {
        calls.push({ params, companyId: call.companyId });
        if (handler) return handler(params, call);
        return { found: true };
      },
    },
  };
  const executor = new ToolExecutor({
    manifest,
    allowedTools,
    audit: (entry) => {
      audit.push(entry);
    },
  });
  return { executor, calls, audit };
}

test('missing or invalid companyId is refused before handler or audit runs', async () => {
  for (const bad of [undefined, null, '', 0, -1, 1.5, 'a b', '../x']) {
    const { executor, calls, audit } = makeExecutor();
    await assert.rejects(
      executor.execute('booking.lookup', { booking_id: 'b1' }, { companyId: bad }),
      (err) => err?.name === 'AiRuntimeError',
    );
    assert.equal(calls.length, 0, `handler must not run for companyId ${String(bad)}`);
    assert.equal(audit.length, 0, `no audit entry for companyId ${String(bad)}`);
  }
});

test('handler receives the context companyId, never a companyId from params', async () => {
  const { executor, calls, audit } = makeExecutor();
  const result = await executor.execute(
    'booking.lookup',
    { booking_id: 'b1', companyId: CO_B, company_id: CO_B },
    { companyId: CO_A, userId: 7 },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].companyId, String(CO_A));
  assert.equal(audit[0].company_id, String(CO_A));
});

test('two tenants stay separate in handler scope and audit trail', async () => {
  const { executor, calls, audit } = makeExecutor();

  await executor.execute('booking.lookup', { booking_id: 'a-1' }, { companyId: CO_A });
  await executor.execute('booking.lookup', { booking_id: 'b-1' }, { companyId: CO_B });

  assert.deepEqual(calls.map((c) => c.companyId), [String(CO_A), String(CO_B)]);
  assert.deepEqual(audit.map((a) => a.company_id), [String(CO_A), String(CO_B)]);
});

test('a tool that is not on the allowlist is blocked for every tenant', async () => {
  const { executor, calls, audit } = makeExecutor({ allowedTools: [] });

  const result = await executor.execute('booking.lookup', { booking_id: 'b1' }, { companyId: CO_A });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'tool_not_allowed');
  assert.equal(calls.length, 0);
  assert.equal(audit[0].status, 'blocked');
  assert.equal(audit[0].company_id, String(CO_A));
});

test('input missing a required field is refused without calling the handler', async () => {
  const { executor, calls } = makeExecutor();

  const result = await executor.execute('booking.lookup', {}, { companyId: CO_A });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'tool_input_invalid');
  assert.ok(result.data.errors.booking_id);
  assert.equal(calls.length, 0);
});

test('a permission check that denies or throws blocks the call for that tenant', async () => {
  const audit = [];
  const calls = [];
  const manifest = {
    'booking.lookup': {
      input_schema: { booking_id: 'required' },
      handler: async (params, call) => {
        calls.push(call.companyId);
        return { ok: true };
      },
    },
  };
  const executor = new ToolExecutor({
    manifest,
    allowedTools: ['booking.lookup'],
    audit: (e) => audit.push(e),
    permissionCheck: (_tool, ctx) => {
      if (ctx.companyId === String(CO_B)) throw new Error('boom');
      return false;
    },
  });

  const denied = await executor.execute('booking.lookup', { booking_id: 'x' }, { companyId: CO_A });
  const thrown = await executor.execute('booking.lookup', { booking_id: 'x' }, { companyId: CO_B });

  assert.equal(denied.error_code, 'tool_permission_denied');
  assert.equal(thrown.error_code, 'tool_permission_denied');
  assert.equal(calls.length, 0);
  assert.deepEqual(audit.map((a) => a.status), ['blocked', 'blocked']);
});

test('dry run returns without side effects and is audited for the caller tenant', async () => {
  const { executor, calls, audit } = makeExecutor();

  const result = await executor.execute('booking.lookup', { booking_id: 'b1' }, { companyId: CO_A, dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.data.dry_run, true);
  assert.equal(calls.length, 0);
  assert.equal(audit[0].status, 'dry_run');
  assert.equal(audit[0].company_id, String(CO_A));
});

test('audit entry stores a hash of the input, not the raw params', async () => {
  const { executor, audit } = makeExecutor();
  const secret = 'sk-test-SECRET-VALUE-123';

  await executor.execute('booking.lookup', { booking_id: 'b1', api_key: secret }, { companyId: CO_A });

  assert.equal(audit.length, 1);
  assert.match(audit[0].input_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(audit[0]).includes(secret), false);
});

test('constructor rejects a missing allowlist', () => {
  assert.throws(
    () => new ToolExecutor({ manifest: {}, allowedTools: undefined }),
    (err) => err?.code === 'config_invalid',
  );
});
