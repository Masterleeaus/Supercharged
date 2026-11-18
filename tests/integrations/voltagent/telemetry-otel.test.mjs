import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelemetry, createOtelTelemetryTracer, OTEL_STATUS_ERROR } from '../../../server/infrastructure/telemetry/index.ts';
import { runAgentTraced, AGENT_RUN_SPAN_NAME, TOOL_CALL_SPAN_NAME } from '../../../server/integrations/voltagent/agents/voltagent-tools.ts';

function fakeOtelApi() {
  const spans = [];
  const api = {
    trace: {
      getTracer(name) {
        api.tracerName = name;
        return {
          startSpan(spanName, options) {
            const span = { name: spanName, attributes: { ...(options?.attributes ?? {}) }, exceptions: [], status: null, ended: false };
            spans.push(span);
            return {
              setAttributes(more) { Object.assign(span.attributes, more); },
              recordException(e) { span.exceptions.push(e); },
              setStatus(s) { span.status = s; },
              end() { span.ended = true; },
            };
          },
        };
      },
    },
  };
  return { api, spans };
}

test('OTel adapter starts a named span with redacted attributes and ends it', async () => {
  const { api, spans } = fakeOtelApi();
  const t = createTelemetry({ enabled: true, tracer: createOtelTelemetryTracer(api, 'test') });
  assert.equal(api.tracerName, 'test');
  await t.withSpan('voltagent.tool.call', { api_key: 'abc', tool_id: 'lookup' }, (span) => {
    span.setAttributes({ outcome_status: 'executed', token: 'zzz' });
    return 'ok';
  });
  assert.equal(spans[0].name, 'voltagent.tool.call');
  assert.equal(spans[0].attributes.api_key, '[redacted]');
  assert.equal(spans[0].attributes.tool_id, 'lookup');
  assert.equal(spans[0].attributes.outcome_status, 'executed');
  assert.equal(spans[0].attributes.token, '[redacted]');
  assert.equal(spans[0].ended, true);
});

test('OTel adapter records a thrown error with a scrubbed message and no stack', async () => {
  const { api, spans } = fakeOtelApi();
  const t = createTelemetry({ enabled: true, tracer: createOtelTelemetryTracer(api) });
  const boom = new TypeError('failed with key sk-abcdefghijklmnopqrstuvwx');
  await assert.rejects(t.withSpan('agent.run', {}, () => { throw boom; }), TypeError);
  const [ex] = spans[0].exceptions;
  assert.equal(ex.name, 'TypeError');
  assert.ok(!ex.message.includes('sk-abcdefghijklmnopqrstuvwx'));
  assert.equal(Object.hasOwn(ex, 'stack'), false);
  assert.deepEqual(spans[0].status, { code: OTEL_STATUS_ERROR, message: 'TypeError' });
  assert.equal(spans[0].ended, true);
});

test('non-Error throws are recorded as a generic error', async () => {
  const { api, spans } = fakeOtelApi();
  const t = createTelemetry({ enabled: true, tracer: createOtelTelemetryTracer(api) });
  await assert.rejects(t.withSpan('x', {}, () => { throw 'plain string'; }));
  assert.deepEqual(spans[0].exceptions[0], { name: 'Error', message: '[redacted]' });
});

test('runAgentTraced wraps the run in an agent span with ids only', async () => {
  const { api, spans } = fakeOtelApi();
  const telemetry = createTelemetry({ enabled: true, tracer: createOtelTelemetryTracer(api) });
  const out = await runAgentTraced(telemetry, { role_id: 'r1', run_id: 'run-9' }, async () => 42);
  assert.equal(out, 42);
  assert.equal(spans[0].name, AGENT_RUN_SPAN_NAME);
  assert.deepEqual(spans[0].attributes, { role_id: 'r1', run_id: 'run-9' });
  assert.equal(spans[0].ended, true);
});

test('runAgentTraced without telemetry runs fn unchanged and creates no span', async () => {
  const { api, spans } = fakeOtelApi();
  assert.equal(await runAgentTraced(undefined, { role_id: 'r', run_id: 'x' }, async () => 'v'), 'v');
  const disabled = createTelemetry({ enabled: false, tracer: createOtelTelemetryTracer(api) });
  assert.equal(await runAgentTraced(disabled, { role_id: 'r', run_id: 'x' }, async () => 'w'), 'w');
  assert.equal(spans.length, 0);
  assert.equal(TOOL_CALL_SPAN_NAME, 'voltagent.tool.call');
});
