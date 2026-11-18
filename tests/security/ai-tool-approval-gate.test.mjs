import test from 'node:test';
import assert from 'node:assert/strict';

const { ToolExecutor } = await import('../../server/services/ai-runtime/tools.ts');

const CO = 101;

function makeExecutor(audit = []) {
  const calls = [];
  const executor = new ToolExecutor({
    manifest: {
      'booking.cancel': {
        requires_approval: true,
        input_schema: { booking_id: 'required' },
        handler: async (params, call) => {
          calls.push({ params, companyId: call.companyId });
          return { cancelled: true };
        },
      },
      'booking.lookup': {
        input_schema: { booking_id: 'required' },
        handler: async (params, call) => {
          calls.push({ params, companyId: call.companyId });
          return { found: true };
        },
      },
    },
    allowedTools: ['booking.cancel', 'booking.lookup'],
    audit: (entry) => {
      audit.push(entry);
    },
  });
  return { executor, calls, audit };
}

test('sensitive tool is blocked without approval and the handler does not run', async () => {
  const { executor, calls, audit } = makeExecutor();
  const result = await executor.execute('booking.cancel', { booking_id: 'b1' }, { companyId: CO });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'tool_approval_required');
  assert.equal(calls.length, 0);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].status, 'blocked');
  assert.equal(audit[0].error, 'tool_approval_required');
});

test('sensitive tool runs when the server sets approved on the context', async () => {
  const { executor, calls, audit } = makeExecutor();
  const result = await executor.execute('booking.cancel', { booking_id: 'b1' }, { companyId: CO, approved: true });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].companyId, String(CO));
  assert.equal(audit[0].status, 'success');
});

test('approval cannot be granted from tool params', async () => {
  const { executor, calls } = makeExecutor();
  const result = await executor.execute(
    'booking.cancel',
    { booking_id: 'b1', approved: true, context: { approved: true } },
    { companyId: CO },
  );

  assert.equal(result.error_code, 'tool_approval_required');
  assert.equal(calls.length, 0);
});

test('approved must be exactly true, not a truthy value', async () => {
  const { executor, calls } = makeExecutor();
  for (const truthy of ['true', 1, {}, []]) {
    const result = await executor.execute('booking.cancel', { booking_id: 'b1' }, { companyId: CO, approved: truthy });
    assert.equal(result.error_code, 'tool_approval_required', `approved=${JSON.stringify(truthy)} must not approve`);
  }
  assert.equal(calls.length, 0);
});

test('dry run of a sensitive tool is allowed without approval and has no side effects', async () => {
  const { executor, calls } = makeExecutor();
  const result = await executor.execute('booking.cancel', { booking_id: 'b1' }, { companyId: CO, dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.data.dry_run, true);
  assert.equal(calls.length, 0);
});

test('tools without requires_approval are unchanged', async () => {
  const { executor, calls } = makeExecutor();
  const result = await executor.execute('booking.lookup', { booking_id: 'b1' }, { companyId: CO });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test('input validation still runs before the approval check', async () => {
  const { executor, calls } = makeExecutor();
  const result = await executor.execute('booking.cancel', {}, { companyId: CO, approved: true });

  assert.equal(result.error_code, 'tool_input_invalid');
  assert.equal(calls.length, 0);
});
