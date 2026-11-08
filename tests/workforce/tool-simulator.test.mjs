/**
 * Tests for server/workforce/tools/simulator.ts. No network, database or handler is reached.
 * Run: node --test --experimental-transform-types tests/workforce/tool-simulator.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolSimulator, runSimulatedWorkflow } from '../../server/workforce/tools/simulator.ts';

const FAKE_TOKEN = 'sk-FAKE-TOKEN-0000-do-not-leak';

let handlerCalls = 0;
function spyHandler() {
  handlerCalls += 1;
  throw new Error('handler must never be called by the simulator');
}

function definitions() {
  return [
    {
      id: 'bookings.list',
      risk: 'low',
      access: 'read',
      schema: { date: { type: 'string', required: true }, limit: { type: 'number' } },
      handler: spyHandler,
    },
    {
      id: 'bookings.cancel',
      risk: 'high',
      access: 'write',
      schema: { bookingId: { type: 'string', required: true } },
      handler: spyHandler,
    },
    {
      id: 'customers.note',
      risk: 'low',
      schema: { text: { type: 'string', required: true } },
      handler: spyHandler,
    },
  ];
}

test('a read step is recorded as wouldExecute true and echoes its input', () => {
  const sim = createToolSimulator(definitions());
  const input = { date: '2026-11-10', limit: 5 };
  const [result] = runSimulatedWorkflow(sim, [{ tool: 'bookings.list', input }]);
  assert.equal(result.tool, 'bookings.list');
  assert.equal(result.wouldExecute, true);
  assert.equal(result.reason, 'would_execute');
  assert.deepEqual(result.input, input);
  assert.equal(handlerCalls, 0);
});

test('a write is refused by default with simulated_write_refused', () => {
  const sim = createToolSimulator(definitions());
  const [result] = runSimulatedWorkflow(sim, [{ tool: 'bookings.cancel', input: { bookingId: 'b1' } }]);
  assert.equal(result.wouldExecute, false);
  assert.equal(result.reason, 'simulated_write_refused');
  assert.equal(handlerCalls, 0);
});

test('a write with allowSimulatedWrite true is only recorded, not executed', () => {
  const sim = createToolSimulator(definitions());
  const [result] = runSimulatedWorkflow(sim, [
    { tool: 'bookings.cancel', input: { bookingId: 'b1' }, allowSimulatedWrite: true },
  ]);
  assert.equal(result.wouldExecute, true);
  assert.equal(result.reason, 'simulated_write_recorded');
  assert.equal(handlerCalls, 0);
});

test('a definition with no access field is treated as a write', () => {
  const sim = createToolSimulator(definitions());
  const [result] = runSimulatedWorkflow(sim, [{ tool: 'customers.note', input: { text: 'hi' } }]);
  assert.equal(result.reason, 'simulated_write_refused');
});

test('a refusal stops the workflow and later steps are not recorded', () => {
  const sim = createToolSimulator(definitions());
  const outcomes = runSimulatedWorkflow(sim, [
    { tool: 'bookings.list', input: { date: '2026-11-10' } },
    { tool: 'bookings.cancel', input: { bookingId: 'b1' } },
    { tool: 'bookings.list', input: { date: '2026-11-11' } },
  ]);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].wouldExecute, true);
  assert.equal(outcomes[1].wouldExecute, false);
  assert.equal(outcomes[1].reason, 'simulated_write_refused');
});

test('unknown tools, bad input and tenant override keys are refused', () => {
  const sim = createToolSimulator(definitions());
  const outcomes = [
    sim.simulate({ tool: 'nope.tool', input: {} }),
    sim.simulate({ tool: 'bookings.list', input: { date: 3 } }),
    sim.simulate({ tool: 'bookings.list', input: { date: '2026-11-10', companyId: 'other' } }),
    sim.simulate({ tool: 'bookings.list', input: ['not', 'an', 'object'] }),
  ];
  assert.deepEqual(
    outcomes.map((o) => o.reason.split(':')[0]),
    ['tool_unknown', 'input_invalid', 'tenant_override', 'input_invalid'],
  );
  assert.ok(outcomes.every((o) => o.wouldExecute === false));
  assert.equal(handlerCalls, 0);
});

test('no handler is ever called, and the handler property is never read', () => {
  const defs = definitions();
  let handlerReads = 0;
  for (const def of defs) {
    Object.defineProperty(def, 'handler', {
      get() {
        handlerReads += 1;
        return spyHandler;
      },
      enumerable: true,
    });
  }
  const sim = createToolSimulator(defs);
  runSimulatedWorkflow(sim, [
    { tool: 'bookings.list', input: { date: '2026-11-10' } },
    { tool: 'bookings.cancel', input: { bookingId: 'b1' }, allowSimulatedWrite: true },
    { tool: 'bookings.list', input: {} },
  ]);
  assert.equal(handlerCalls, 0);
  assert.equal(handlerReads, 0);
});

test('a fake token in input never appears in any reason string', () => {
  const sim = createToolSimulator(definitions());
  const outcomes = [
    sim.simulate({ tool: 'bookings.cancel', input: { bookingId: 'b1', token: FAKE_TOKEN } }),
    sim.simulate({ tool: 'bookings.list', input: { date: FAKE_TOKEN } }),
    sim.simulate({ tool: 'bookings.list', input: { date: '2026-11-10', apiKey: FAKE_TOKEN, token: FAKE_TOKEN } }),
    sim.simulate({ tool: 'bookings.cancel', input: { bookingId: FAKE_TOKEN }, allowSimulatedWrite: true }),
  ];
  for (const o of outcomes) {
    assert.ok(!o.reason.includes(FAKE_TOKEN), `reason leaked token: ${o.reason}`);
    assert.ok(!o.tool.includes(FAKE_TOKEN));
  }
  // The input is echoed as given, so the token only appears on the outcome's input field.
  assert.equal(outcomes[0].input.token, FAKE_TOKEN);
});

test('runSimulatedWorkflow returns an empty list for an empty workflow and rejects bad arguments', () => {
  const sim = createToolSimulator(definitions());
  assert.deepEqual(runSimulatedWorkflow(sim, []), []);
  assert.throws(() => runSimulatedWorkflow(sim, 'not-an-array'));
  assert.throws(() => createToolSimulator([{ id: '', schema: {}, handler: spyHandler }]));
  assert.throws(() => createToolSimulator([...definitions(), definitions()[0]]));
  assert.equal(handlerCalls, 0);
});
