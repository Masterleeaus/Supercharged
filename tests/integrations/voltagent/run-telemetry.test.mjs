import assert from 'node:assert/strict';
import test from 'node:test';
import {
  withRunTelemetry,
  createTelemetry,
  RUN_START_SPAN,
  RUN_FINISH_SPAN,
  RUN_FAILURE_SPAN,
} from '../../../server/infrastructure/telemetry/index.ts';

const COMPANY = 'company-1234';
const RUN = 'run-5678';
const SECRET = 'sk-abcdefghijklmnopqrstuvwx';
const BODY = 'Please call me at the kitchen door about the leak in the hallway';

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

/** A fake engine whose results can be set per test. Every call is recorded. */
function fakeEngine(results = {}) {
  const calls = [];
  const pick = (name, fallback) => async (...args) => {
    calls.push({ name, args });
    if (results[name] instanceof Error) throw results[name];
    return results[name] ?? fallback;
  };
  return {
    calls,
    startRun: pick('startRun', { ok: true, run: { id: RUN } }),
    complete: pick('complete', { ok: true, run: { id: RUN } }),
    fail: pick('fail', { ok: true, run: { id: RUN } }),
    cancel: pick('cancel', { ok: true, run: { id: RUN } }),
    callTool: pick('callTool', { ok: true }),
  };
}

function enabled(tracer) {
  return createTelemetry({ enabled: true, tracer });
}

test('start emits one span with run id and company id, outcome started', async () => {
  const tracer = fakeTracer();
  const engine = withRunTelemetry(fakeEngine(), enabled(tracer));
  const result = await engine.startRun(COMPANY, RUN);
  assert.equal(result.ok, true);
  assert.equal(tracer.spans.length, 1);
  const [span] = tracer.spans;
  assert.equal(span.name, RUN_START_SPAN);
  assert.equal(span.attrs.run_id, RUN);
  assert.equal(span.attrs.company_id, COMPANY);
  assert.equal(span.attrs.outcome, 'started');
  assert.equal(span.ended, true);
});

test('a refused start is marked rejected with the engine refusal code', async () => {
  const tracer = fakeTracer();
  const engine = withRunTelemetry(fakeEngine({ startRun: { ok: false, reason: 'run_not_queued', run: null } }), enabled(tracer));
  await engine.startRun(COMPANY, RUN);
  assert.equal(tracer.spans[0].attrs.outcome, 'rejected');
  assert.equal(tracer.spans[0].attrs.refusal_code, 'run_not_queued');
});

test('complete emits a finish span with outcome completed', async () => {
  const tracer = fakeTracer();
  const engine = withRunTelemetry(fakeEngine(), enabled(tracer));
  await engine.complete(COMPANY, RUN, 'done');
  assert.equal(tracer.spans[0].name, RUN_FINISH_SPAN);
  assert.equal(tracer.spans[0].attrs.outcome, 'completed');
  assert.equal(tracer.spans[0].attrs.run_id, RUN);
  assert.equal(tracer.spans[0].attrs.company_id, COMPANY);
});

test('cancel emits a finish span with outcome cancelled', async () => {
  const tracer = fakeTracer();
  const engine = withRunTelemetry(fakeEngine(), enabled(tracer));
  await engine.cancel(COMPANY, RUN);
  assert.equal(tracer.spans[0].name, RUN_FINISH_SPAN);
  assert.equal(tracer.spans[0].attrs.outcome, 'cancelled');
});

test('fail emits a failure span with outcome failed', async () => {
  const tracer = fakeTracer();
  const engine = withRunTelemetry(fakeEngine(), enabled(tracer));
  await engine.fail(COMPANY, RUN, 'tool_timeout');
  assert.equal(tracer.spans[0].name, RUN_FAILURE_SPAN);
  assert.equal(tracer.spans[0].attrs.outcome, 'failed');
  assert.equal(tracer.spans[0].attrs.run_id, RUN);
  assert.equal(tracer.spans[0].attrs.company_id, COMPANY);
});

test('an engine exception on fail is recorded on the span and rethrown', async () => {
  const tracer = fakeTracer();
  const boom = new Error('store down');
  const engine = withRunTelemetry(fakeEngine({ fail: boom }), enabled(tracer));
  await assert.rejects(engine.fail(COMPANY, RUN, 'x'), /store down/);
  assert.equal(tracer.spans[0].name, RUN_FAILURE_SPAN);
  assert.equal(tracer.spans[0].errors[0], boom);
  assert.equal(tracer.spans[0].ended, true);
});

test('the engine result is returned unchanged for every wrapped call', async () => {
  const tracer = fakeTracer();
  const inner = fakeEngine({ complete: { ok: false, reason: 'run_terminal', run: null } });
  const engine = withRunTelemetry(inner, enabled(tracer));
  assert.deepEqual(await engine.complete(COMPANY, RUN), { ok: false, reason: 'run_terminal', run: null });
});

test('methods that are not wrapped pass through without a span', async () => {
  const tracer = fakeTracer();
  const engine = withRunTelemetry(fakeEngine(), enabled(tracer));
  assert.deepEqual(await engine.callTool(COMPANY, RUN, { toolId: 't', params: {} }), { ok: true });
  assert.equal(tracer.spans.length, 0);
});

test('disabled telemetry returns the engine itself and emits nothing', async () => {
  const tracer = fakeTracer();
  const inner = fakeEngine();
  const engine = withRunTelemetry(inner, createTelemetry({ enabled: false, tracer }));
  assert.equal(engine, inner);
  await engine.startRun(COMPANY, RUN);
  await engine.fail(COMPANY, RUN, 'x');
  assert.equal(tracer.spans.length, 0);
});

test('an invalid company id is not put on the span', async () => {
  const tracer = fakeTracer();
  const engine = withRunTelemetry(fakeEngine({ startRun: { ok: false, reason: 'company_invalid', run: null } }), enabled(tracer));
  await engine.startRun({ not: 'a string' }, RUN);
  assert.equal(tracer.spans[0].attrs.company_id, undefined);
  assert.equal(tracer.spans[0].attrs.run_id, RUN);
});

test('negative: no secret or message body reaches any span, even when passed to the run', async () => {
  const tracer = fakeTracer();
  const engine = withRunTelemetry(fakeEngine(), enabled(tracer));
  await engine.startRun(COMPANY, RUN);
  await engine.fail(COMPANY, RUN, `upstream said Bearer ${SECRET} and ${BODY}`);
  await engine.complete(COMPANY, RUN, BODY);
  const emitted = JSON.stringify(tracer.spans.map((s) => s.attrs));
  assert.ok(!emitted.includes(SECRET), 'secret must not be emitted');
  assert.ok(!emitted.includes('kitchen door'), 'message body must not be emitted');
  assert.ok(!emitted.includes('leak in the hallway'), 'message body must not be emitted');
});

test('negative: a secret-named or free-text attribute from a caller is never emitted as its raw value', () => {
  const tracer = fakeTracer();
  const engine = withRunTelemetry(fakeEngine(), enabled(tracer));
  // Reason text is free text and is never copied to the span.
  return engine.fail(COMPANY, RUN, SECRET).then(() => {
    const keys = Object.keys(tracer.spans[0].attrs);
    assert.deepEqual(keys.sort(), ['company_id', 'outcome', 'run_id']);
    assert.ok(!JSON.stringify(tracer.spans[0].attrs).includes(SECRET));
  });
});
