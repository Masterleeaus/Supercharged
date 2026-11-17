import assert from 'node:assert/strict';
import test from 'node:test';
import { redactAttributes, createTelemetry, TELEMETRY_VALUE_MAX } from '../../../server/infrastructure/telemetry/index.ts';

function fakeTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name, attrs) {
      const span = { name, attrs: { ...attrs }, errors: [], ended: false };
      spans.push(span);
      return {
        setAttributes(more) { Object.assign(span.attrs, more); },
        recordError(e) { span.errors.push(e); },
        end() { span.ended = true; },
      };
    },
  };
}

test('sensitive keys are masked whatever the value', () => {
  const out = redactAttributes({ api_key: 'anything', authorization: 'Bearer x', db_password: 'p', tool: 'lookup' });
  assert.equal(out.api_key, '[redacted]');
  assert.equal(out.authorization, '[redacted]');
  assert.equal(out.db_password, '[redacted]');
  assert.equal(out.tool, 'lookup');
});

test('secret-shaped values inside strings are scrubbed', () => {
  const out = redactAttributes({ note: 'key sk-abcdefghijklmnopqrstuvwx used' });
  assert.ok(!out.note.includes('sk-abcdefghijklmnopqrstuvwx'));
});

test('long strings are truncated', () => {
  const out = redactAttributes({ prompt: 'a'.repeat(1000) });
  assert.equal(out.prompt.length, TELEMETRY_VALUE_MAX + 3);
});

test('objects, arrays and non-finite numbers are dropped', () => {
  const out = redactAttributes({ nested: { a: 1 }, list: [1], bad: Number.NaN, ok: 2 });
  assert.deepEqual(out, { ok: 2 });
});

test('disabled telemetry runs the function and never touches the tracer', async () => {
  const tracer = fakeTracer();
  const t = createTelemetry({ enabled: false, tracer });
  assert.equal(t.enabled, false);
  assert.equal(await t.withSpan('agent.run', {}, () => 7), 7);
  assert.equal(tracer.spans.length, 0);
});

test('enabled telemetry without a tracer is still a no-op', async () => {
  const t = createTelemetry({ enabled: true, tracer: null });
  assert.equal(t.enabled, false);
  assert.equal(await t.withSpan('tool.call', {}, () => 'ok'), 'ok');
});

test('enabled telemetry records redacted attributes and ends the span', async () => {
  const tracer = fakeTracer();
  const t = createTelemetry({ enabled: true, tracer });
  await t.withSpan('tool.call', { token: 'secret-value', tool: 'lookup' }, () => 'done');
  assert.equal(tracer.spans[0].attrs.token, '[redacted]');
  assert.equal(tracer.spans[0].attrs.tool, 'lookup');
  assert.equal(tracer.spans[0].ended, true);
});

test('a thrown error is recorded, the span ends, and the error is rethrown', async () => {
  const tracer = fakeTracer();
  const t = createTelemetry({ enabled: true, tracer });
  const boom = new Error('boom');
  await assert.rejects(t.withSpan('agent.run', {}, () => { throw boom; }), /boom/);
  assert.equal(tracer.spans[0].errors[0], boom);
  assert.equal(tracer.spans[0].ended, true);
});
