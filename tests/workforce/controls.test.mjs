/**
 * Tests for server/workforce/runtime/controls.ts. In-memory only: no network, no database, no timers.
 * Run: node --test --experimental-transform-types tests/workforce/controls.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createControlState,
  pauseAgent,
  resumeAgent,
  disableAgent,
  retireAgent,
  stopRun,
  canStartWork,
  isRunStopped,
} from '../../server/workforce/runtime/controls.ts';

const CO_A = 'company-a';
const CO_B = 'company-b';
const AGENT = 'agent-1';
const RUN = 'run-1';
const HUMAN = { kind: 'human', userId: 'owner-1' };
const AGENT_ACTOR = { kind: 'agent', agentId: AGENT };
const FIXED = () => new Date('2026-11-03T00:00:00.000Z');

test('a new state has no agents and no stopped runs', () => {
  const state = createControlState();
  assert.equal(state.agents.size, 0);
  assert.equal(state.runs.size, 0);
  assert.equal(canStartWork(state, CO_A, AGENT).allowed, true);
  assert.equal(isRunStopped(state, RUN), false);
});

test('pause moves active to paused and records the actor and time', () => {
  const r = pauseAgent(createControlState(), CO_A, AGENT, HUMAN, { now: FIXED });
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, 'paused');
  assert.equal(r.entry.changed.by, 'human:owner-1');
  assert.equal(r.entry.changed.at, '2026-11-03T00:00:00.000Z');
  assert.equal(r.state.agents.get(CO_A).get(AGENT).status, 'paused');
});

test('resume moves paused back to active', () => {
  const paused = pauseAgent(createControlState(), CO_A, AGENT, HUMAN).state;
  const r = resumeAgent(paused, CO_A, AGENT, HUMAN);
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, 'active');
  assert.equal(canStartWork(r.state, CO_A, AGENT).allowed, true);
});

test('disable moves active or paused to disabled, and resume can bring it back', () => {
  const fromActive = disableAgent(createControlState(), CO_A, AGENT, HUMAN);
  assert.equal(fromActive.ok, true);
  assert.equal(fromActive.entry.status, 'disabled');

  const fromPaused = disableAgent(pauseAgent(createControlState(), CO_A, AGENT, HUMAN).state, CO_A, AGENT, HUMAN);
  assert.equal(fromPaused.ok, true);
  assert.equal(fromPaused.entry.status, 'disabled');

  const back = resumeAgent(fromActive.state, CO_A, AGENT, HUMAN);
  assert.equal(back.ok, true);
  assert.equal(back.entry.status, 'active');
});

test('retire moves active, paused or disabled to retired', () => {
  const r1 = retireAgent(createControlState(), CO_A, AGENT, HUMAN);
  assert.equal(r1.ok, true);
  assert.equal(r1.entry.status, 'retired');

  const r2 = retireAgent(pauseAgent(createControlState(), CO_A, AGENT, HUMAN).state, CO_A, AGENT, HUMAN);
  assert.equal(r2.ok, true);

  const r3 = retireAgent(disableAgent(createControlState(), CO_A, AGENT, HUMAN).state, CO_A, AGENT, HUMAN);
  assert.equal(r3.ok, true);
});

test('invalid transitions are refused with invalid_transition and leave state unchanged', () => {
  const state = createControlState();
  const resumeActive = resumeAgent(state, CO_A, AGENT, HUMAN);
  assert.deepEqual([resumeActive.ok, resumeActive.reason], [false, 'invalid_transition']);
  assert.equal(resumeActive.state, state);

  const paused = pauseAgent(state, CO_A, AGENT, HUMAN).state;
  const pauseAgain = pauseAgent(paused, CO_A, AGENT, HUMAN);
  assert.deepEqual([pauseAgain.ok, pauseAgain.reason], [false, 'invalid_transition']);

  const disabled = disableAgent(state, CO_A, AGENT, HUMAN).state;
  const pauseDisabled = pauseAgent(disabled, CO_A, AGENT, HUMAN);
  assert.deepEqual([pauseDisabled.ok, pauseDisabled.reason], [false, 'invalid_transition']);
});

test('transitions do not mutate the state they were given', () => {
  const before = createControlState();
  const after = pauseAgent(before, CO_A, AGENT, HUMAN);
  assert.equal(before.agents.size, 0);
  assert.equal(after.state.agents.size, 1);
  assert.notEqual(after.state, before);
});

test('company namespaces: company B pausing the same agent id does not touch company A', () => {
  const owned = pauseAgent(createControlState(), CO_A, AGENT, HUMAN).state;
  for (const fn of [pauseAgent, disableAgent, retireAgent]) {
    const r = fn(owned, CO_B, AGENT, HUMAN);
    assert.equal(r.ok, true);
    assert.equal(r.entry.companyId, CO_B);
    assert.equal(canStartWork(r.state, CO_A, AGENT).reason, 'agent_paused');
    assert.equal(r.state.agents.get(CO_A).get(AGENT).status, 'paused');
  }
  assert.equal(owned.agents.get(CO_A).get(AGENT).status, 'paused');
  assert.equal(owned.agents.get(CO_B), undefined);
});

test('company namespaces: company B stopping a run id does not stop company A run', () => {
  const owned = stopRun(createControlState(), CO_A, RUN, HUMAN);
  const attempt = stopRun(owned.state, CO_B, RUN, HUMAN);
  assert.equal(attempt.ok, true);
  assert.equal(isRunStopped(attempt.state, RUN, CO_A), true);
  assert.equal(isRunStopped(attempt.state, RUN, CO_B), true);
  assert.equal(isRunStopped(owned.state, RUN, CO_B), false);
});

test('company namespaces: company B work is not blocked by a pause on company A agent', () => {
  const paused = pauseAgent(createControlState(), CO_A, AGENT, HUMAN).state;
  assert.deepEqual(canStartWork(paused, CO_B, AGENT), { allowed: true });
  assert.deepEqual(canStartWork(paused, CO_A, AGENT), { allowed: false, reason: 'agent_paused' });
});

test('agent actor is refused for pause, resume, disable and retire with human_only', () => {
  const state = createControlState();
  for (const fn of [pauseAgent, disableAgent, retireAgent]) {
    const r = fn(state, CO_A, AGENT, AGENT_ACTOR);
    assert.deepEqual([r.ok, r.reason], [false, 'human_only']);
    assert.equal(r.state, state);
  }
  const paused = pauseAgent(state, CO_A, AGENT, HUMAN).state;
  const r = resumeAgent(paused, CO_A, AGENT, AGENT_ACTOR);
  assert.deepEqual([r.ok, r.reason], [false, 'human_only']);
  assert.equal(paused.agents.get(CO_A).get(AGENT).status, 'paused');
});

test('agent actor may stop a run', () => {
  const r = stopRun(createControlState(), CO_A, RUN, AGENT_ACTOR);
  assert.equal(r.ok, true);
  assert.equal(r.entry.changed.by, 'agent:agent-1');
});

test('malformed actors, companies and ids are refused', () => {
  const state = createControlState();
  assert.equal(pauseAgent(state, CO_A, AGENT, { kind: 'human' }).reason, 'actor_invalid');
  assert.equal(pauseAgent(state, CO_A, AGENT, null).reason, 'actor_invalid');
  assert.equal(pauseAgent(state, '', AGENT, HUMAN).reason, 'company_id_required');
  assert.equal(pauseAgent(state, CO_A, '', HUMAN).reason, 'agent_id_required');
  assert.equal(stopRun(state, CO_A, '', HUMAN).reason, 'run_id_required');
  assert.equal(stopRun(state, CO_A, RUN, { kind: 'robot' }).reason, 'actor_invalid');
  assert.deepEqual(canStartWork(state, '', AGENT), { allowed: false, reason: 'company_id_required' });
});

test('paused agent cannot start new work, with reason agent_paused', () => {
  const paused = pauseAgent(createControlState(), CO_A, AGENT, HUMAN).state;
  assert.deepEqual(canStartWork(paused, CO_A, AGENT), { allowed: false, reason: 'agent_paused' });
});

test('disabled agent cannot start new work, with reason agent_disabled', () => {
  const disabled = disableAgent(createControlState(), CO_A, AGENT, HUMAN).state;
  assert.deepEqual(canStartWork(disabled, CO_A, AGENT), { allowed: false, reason: 'agent_disabled' });
});

test('retired agent cannot start new work, with reason agent_retired', () => {
  const retired = retireAgent(createControlState(), CO_A, AGENT, HUMAN).state;
  assert.deepEqual(canStartWork(retired, CO_A, AGENT), { allowed: false, reason: 'agent_retired' });
});

test('active agent and unknown agent may start work', () => {
  const state = createControlState();
  assert.deepEqual(canStartWork(state, CO_A, AGENT), { allowed: true });
  const resumed = resumeAgent(disableAgent(state, CO_A, AGENT, HUMAN).state, CO_A, AGENT, HUMAN).state;
  assert.deepEqual(canStartWork(resumed, CO_A, AGENT), { allowed: true });
});

test('stopped run is reported stopped; other runs are not', () => {
  const r = stopRun(createControlState(), CO_A, RUN, HUMAN, { now: FIXED });
  assert.equal(r.ok, true);
  assert.equal(r.entry.stopped, true);
  assert.equal(r.entry.changed.by, 'human:owner-1');
  assert.equal(isRunStopped(r.state, RUN), true);
  assert.equal(isRunStopped(r.state, 'run-2'), false);
  assert.equal(isRunStopped(createControlState(), RUN), false);
});

test('stopping a run again by its owner is accepted and keeps it stopped', () => {
  const first = stopRun(createControlState(), CO_A, RUN, HUMAN).state;
  const again = stopRun(first, CO_A, RUN, AGENT_ACTOR);
  assert.equal(again.ok, true);
  assert.equal(isRunStopped(again.state, RUN), true);
});

test('retired is terminal: every control and every start is refused', () => {
  const retired = retireAgent(createControlState(), CO_A, AGENT, HUMAN).state;
  for (const fn of [pauseAgent, resumeAgent, disableAgent, retireAgent]) {
    const r = fn(retired, CO_A, AGENT, HUMAN);
    assert.deepEqual([r.ok, r.reason], [false, 'agent_retired']);
    assert.equal(r.state, retired);
  }
  assert.equal(canStartWork(retired, CO_A, AGENT).allowed, false);
});
