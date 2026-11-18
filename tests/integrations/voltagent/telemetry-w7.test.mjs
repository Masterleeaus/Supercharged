/**
 * W7 (#391): tests for the telemetry spans, redaction and usage receipt added from feature/w7-telemetry.
 * Uses a fake tracer. No exporter, no network. Flag off by default.
 * Run: node --test --experimental-transform-types tests/integrations/voltagent/telemetry-w7.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelemetry, isTelemetryEnabled, AGENT_RUN_SPAN, TOOL_CALL_SPAN } from '../../../server/infrastructure/telemetry/spans.ts';
import { redactTelemetryAttributes, scrubText } from '../../../server/infrastructure/telemetry/telemetry-redact.ts';
import { buildUsageReceipt } from '../../../server/infrastructure/telemetry/receipt.ts';

const ON = { VOLTAGENT_TELEMETRY_ENABLED: 'true' };

function fakeTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name) {
      const span = {
        name,
        attributes: {},
        status: null,
        ended: false,
        setAttributes(a) {
          Object.assign(this.attributes, a);
        },
        setAttribute(k, v) {
          this.attributes[k] = v;
        },
        setStatus(s) {
          this.status = s;
        },
        end() {
          this.ended = true;
        },
      };
      spans.push(span);
      return span;
    },
  };
}

test('telemetry is off unless the flag is exactly "true"', () => {
  assert.equal(isTelemetryEnabled({}), false);
  assert.equal(isTelemetryEnabled({ VOLTAGENT_TELEMETRY_ENABLED: 'TRUE' }), false);
  assert.equal(isTelemetryEnabled(ON), true);
});

test('with the flag off the tracer is never created and the wrapped function runs', async () => {
  let created = false;
  const t = createTelemetry({ env: {}, createTracer: () => ((created = true), fakeTracer()) });
  assert.equal(t.enabled, false);
  const out = await t.traceToolCall({ toolId: 'x' }, () => 'ran');
  assert.equal(out, 'ran');
  assert.equal(created, false);
});

test('an enabled agent run records a redacted company id and usage, then ends the span', async () => {
  const tracer = fakeTracer();
  const t = createTelemetry({ env: ON, createTracer: () => tracer });
  const out = await t.traceAgentRun({ companyId: 'co-1', agentId: 'a', runId: 'r1' }, (rec) => {
    rec.setUsage({ inputTokens: 10, outputTokens: 4 });
    return 'done';
  });
  assert.equal(out, 'done');
  const span = tracer.spans[0];
  assert.equal(span.name, AGENT_RUN_SPAN);
  assert.equal(span.attributes['titan.company_id'], 'co-1');
  assert.equal(span.attributes['gen_ai.usage.input_tokens'], 10);
  assert.equal(span.attributes['titan.status'], 'ok');
  assert.equal(span.ended, true);
});

test('a thrown tool error is recorded with its code, the span ends, and the error is rethrown', async () => {
  const tracer = fakeTracer();
  const t = createTelemetry({ env: ON, createTracer: () => tracer });
  const err = Object.assign(new Error('boom'), { code: 'tool_timeout' });
  await assert.rejects(t.traceToolCall({ companyId: 'co-1', toolId: 'send_quote' }, () => { throw err; }), /boom/);
  const span = tracer.spans[0];
  assert.equal(span.name, TOOL_CALL_SPAN);
  assert.equal(span.attributes['titan.status'], 'error');
  assert.equal(span.attributes['titan.error_code'], 'tool_timeout');
  assert.equal(span.ended, true);
});

test('span attributes are redacted: an email in a company id field is not written', async () => {
  const tracer = fakeTracer();
  const t = createTelemetry({ env: ON, createTracer: () => tracer });
  await t.traceToolCall({ companyId: 'owner@example.com', toolId: 't' }, () => 1);
  assert.doesNotMatch(JSON.stringify(tracer.spans[0].attributes), /owner@example\.com/);
});

test('scrubText removes an email address and a bearer token from free text', () => {
  const out = scrubText('mail jo@example.com with Bearer abc.def.ghi');
  assert.doesNotMatch(out, /jo@example\.com/);
  assert.doesNotMatch(out, /abc\.def\.ghi/);
});

test('redactTelemetryAttributes keeps only allowlisted keys and simple values', () => {
  const out = redactTelemetryAttributes({
    'titan.company_id': 'co-1',
    'not.allowed': 'x',
    'gen_ai.usage.input_tokens': 5,
    nested: { a: 1 },
  });
  assert.equal(out['titan.company_id'], 'co-1');
  assert.equal(out['gen_ai.usage.input_tokens'], 5);
  assert.equal('not.allowed' in out, false);
  assert.equal('nested' in out, false);
});

test('the usage receipt sums tokens and counts runs and tool calls per company', () => {
  const rows = buildUsageReceipt([
    { name: AGENT_RUN_SPAN, attributes: { 'titan.company_id': 'co-1', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 5 } },
    { name: AGENT_RUN_SPAN, attributes: { 'titan.company_id': 'co-1', 'gen_ai.usage.input_tokens': 2, 'gen_ai.usage.output_tokens': 1 } },
    { name: TOOL_CALL_SPAN, attributes: { 'titan.company_id': 'co-1' } },
    { name: TOOL_CALL_SPAN, attributes: { 'titan.company_id': 'co-2' } },
    { name: 'other.span', attributes: { 'titan.company_id': 'co-1' } },
    { name: AGENT_RUN_SPAN, attributes: { 'gen_ai.usage.input_tokens': 99 } },
  ]);
  const co1 = rows.find((r) => r.companyId === 'co-1');
  assert.deepEqual(
    [co1.runs, co1.toolCalls, co1.inputTokens, co1.outputTokens, co1.totalTokens],
    [2, 1, 12, 6, 18],
  );
  assert.equal(rows.find((r) => r.companyId === 'co-2').toolCalls, 1);
  assert.equal(rows.length, 2);
});
