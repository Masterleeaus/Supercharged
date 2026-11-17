import assert from 'node:assert/strict';
import test from 'node:test';
import { SpanStatusCode } from '@opentelemetry/api';
import { createTelemetry } from '../../../server/infrastructure/telemetry/spans.ts';
import { redactTelemetryAttributes } from '../../../server/infrastructure/telemetry/redact.ts';
import { buildUsageReceipt } from '../../../server/infrastructure/telemetry/receipt.ts';

const ON = { VOLTAGENT_TELEMETRY_ENABLED: 'true' };

/** Fake tracer that records every span, its attributes and its status. */
const fakeTracer = () => {
  const spans = [];
  return {
    spans,
    tracer: {
      startSpan(name) {
        const record = { name, attributes: {}, status: undefined, ended: false };
        spans.push(record);
        return {
          setAttributes(attrs) {
            Object.assign(record.attributes, attrs);
          },
          setAttribute(key, value) {
            record.attributes[key] = value;
          },
          setStatus(status) {
            record.status = status;
          },
          end() {
            record.ended = true;
          },
        };
      },
    },
  };
};

const allValues = (spans) => spans.flatMap((s) => Object.values(s.attributes).map(String)).join('\n');

test('flag unset creates no exporter and traces nothing', async () => {
  let created = 0;
  const telemetry = createTelemetry({
    env: {},
    createTracer: () => {
      created += 1;
      return fakeTracer().tracer;
    },
  });
  assert.equal(telemetry.enabled, false);
  assert.equal(created, 0);
  const value = await telemetry.traceToolCall({ toolId: 'lookup', companyId: 'co-1' }, () => 42);
  assert.equal(value, 42);
});

test('flag must be exactly "true" to enable', () => {
  let created = 0;
  for (const value of ['1', 'TRUE', 'yes']) {
    const telemetry = createTelemetry({
      env: { VOLTAGENT_TELEMETRY_ENABLED: value },
      createTracer: () => {
        created += 1;
        return fakeTracer().tracer;
      },
    });
    assert.equal(telemetry.enabled, false);
  }
  assert.equal(created, 0);
});

test('redaction removes an email, a phone number and a token from span attributes', () => {
  const out = redactTelemetryAttributes({
    'titan.company_id': 'co-1',
    'titan.tool_id': 'send_email',
    'titan.error_code': 'a@example.com',
    'titan.agent_id': '+61 412 345 678',
    'titan.run_id': 'sk_live_abcdef1234567890',
  });
  assert.deepEqual(out, { 'titan.company_id': 'co-1', 'titan.tool_id': 'send_email' });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('example.com'));
  assert.ok(!text.includes('412'));
  assert.ok(!text.includes('sk_live'));
});

test('a token inside a tool id is removed, not copied to the span', async () => {
  const { spans, tracer } = fakeTracer();
  const telemetry = createTelemetry({ env: ON, createTracer: () => tracer });
  await telemetry.traceToolCall({ toolId: 'call sk_live_abcdef1234567890 now', companyId: 'co-1' }, () => 1);
  assert.ok(!allValues(spans).includes('sk_live'));
});

test('a tool call makes one span with status and duration', async () => {
  const { spans, tracer } = fakeTracer();
  let t = 1000;
  const telemetry = createTelemetry({ env: ON, createTracer: () => tracer, now: () => (t += 5) });
  const result = await telemetry.traceToolCall(
    { toolId: 'create_booking', companyId: 'co-1', agentId: 'agent-7', runId: 'run-9' },
    () => 'ok'
  );
  assert.equal(result, 'ok');
  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(span.name, 'tool.call');
  assert.equal(span.attributes['titan.tool_id'], 'create_booking');
  assert.equal(span.attributes['titan.status'], 'ok');
  assert.equal(typeof span.attributes['titan.duration_ms'], 'number');
  assert.equal(span.ended, true);
});

test('a failing tool call records error status and a short code only', async () => {
  const { spans, tracer } = fakeTracer();
  const telemetry = createTelemetry({ env: ON, createTracer: () => tracer });
  await assert.rejects(
    telemetry.traceToolCall({ toolId: 'x', companyId: 'co-1' }, () => {
      const err = new Error('user jane@example.com not found');
      err.code = 'not_found';
      throw err;
    })
  );
  const [span] = spans;
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.attributes['titan.status'], 'error');
  assert.equal(span.attributes['titan.error_code'], 'not_found');
  assert.ok(!allValues(spans).includes('jane'));
});

test('a receipt counts two tool calls correctly for one company', async () => {
  const { spans, tracer } = fakeTracer();
  const telemetry = createTelemetry({ env: ON, createTracer: () => tracer });
  await telemetry.traceAgentRun({ companyId: 'co-1', agentId: 'a1', runId: 'r1' }, async (rec) => {
    rec.setUsage({ inputTokens: 120, outputTokens: 30 });
    await telemetry.traceToolCall({ toolId: 'lookup', companyId: 'co-1', runId: 'r1' }, () => 1);
    await telemetry.traceToolCall({ toolId: 'book', companyId: 'co-1', runId: 'r1' }, () => 2);
  });
  const receipt = buildUsageReceipt(spans);
  assert.deepEqual(receipt, [
    { companyId: 'co-1', runs: 1, toolCalls: 2, inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  ]);
});

test('no raw message text reaches any attribute', async () => {
  const { spans, tracer } = fakeTracer();
  const telemetry = createTelemetry({ env: ON, createTracer: () => tracer });
  const message = 'Hi, I am Sam Lee, call me on +61 400 111 222 or sam@example.com. Card 4111111111111111';
  await telemetry.traceAgentRun({ companyId: 'co-1', agentId: 'a1', runId: 'r1', message }, async (rec) => {
    rec.setUsage({ inputTokens: 10, outputTokens: 5 });
    return message;
  });
  const values = allValues(spans);
  assert.ok(!values.includes('Sam Lee'));
  assert.ok(!values.includes('400 111 222'));
  assert.ok(!values.includes('sam@example.com'));
  assert.ok(!values.includes('4111111111111111'));
  assert.ok(!values.includes('Hi, I am'));
});

test('receipt skips spans with no company id and ignores other span names', () => {
  const rows = buildUsageReceipt([
    { name: 'tool.call', attributes: { 'titan.tool_id': 'x' } },
    { name: 'other', attributes: { 'titan.company_id': 'co-2' } },
  ]);
  assert.deepEqual(rows, []);
});
