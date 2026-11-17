/**
 * Tests for the VoltAgent registry bridge. Real run engine, in-memory run store, fake approval gate,
 * fake handlers. No network, no database.
 * Run: node --test tests/integrations/voltagent/agents.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createToolRegistry,
  createRunEngine,
  createTeam,
  createMemoryRunStore,
} from '../../../server/workforce/runtime/index.ts';
import { buildRegistryTools, VOLTAGENT_AGENTS_DISABLED_MESSAGE } from '../../../server/integrations/voltagent/agents/bridge.ts';

const CO = 'company-1';
const ON = { VOLTAGENT_AGENTS_ENABLED: 'true' };

// ---------- fixtures ----------

const ROLE_LIST = [
  { id: 'coordinator', handoffTo: ['writer', 'reviewer', 'booker'], autonomy: 'auto' },
  { id: 'writer', handoffTo: ['reviewer'], autonomy: 'auto' },
  { id: 'reviewer', handoffTo: ['writer', 'coordinator'], autonomy: 'auto' },
  { id: 'booker', handoffTo: [], autonomy: 'auto', toolRisk: {} },
];
const ROLES = new Map(ROLE_LIST.map((r) => [r.id, r]));
const roleSource = { getRole: (id) => ROLES.get(id) ?? null };

function makeTeam() {
  return createTeam(
    {
      id: 'team-1',
      name: 'Content',
      members: ['coordinator', 'writer', 'reviewer', 'booker'].map((roleId) => ({ roleId, coordinator: roleId === 'coordinator' })),
    },
    roleSource,
  );
}

function fakeGate() {
  const approvals = new Map();
  let seq = 0;
  return {
    approvals,
    async gateAction(req) {
      const id = `ap-${++seq}`;
      approvals.set(id, {
        id,
        companyId: req.companyId,
        action: req.action,
        status: 'pending',
        decidedBy: null,
        paramsSha256: req.context.paramsSha256,
        executed: false,
      });
      return { status: 'pending', approval: { id } };
    },
    async readApproval(companyId, id) {
      const a = approvals.get(id);
      return a ? { ...a } : null;
    },
    async claimApproval(companyId, id) {
      const a = approvals.get(id);
      if (!a || a.companyId !== companyId || a.status !== 'approved' || a.executed) return false;
      a.executed = true;
      return true;
    },
  };
}

const redact = (value) => value;

/** Registry with one low-risk tool, one high-risk tool and one tool no test lists. Handlers count their calls. */
function setup() {
  const store = createMemoryRunStore();
  const gate = fakeGate();
  const sink = { record: (event) => store.appendAudit(event) };
  const registry = createToolRegistry({ gate, redact, audit: sink });
  const calls = { read_note: 0, publish_page: 0, unlisted_tool: 0 };
  registry.register({
    id: 'read_note',
    risk: 'low',
    schema: { slug: { type: 'string', required: true } },
    handler: (params) => {
      calls.read_note += 1;
      return { slug: params.slug, body: 'hello' };
    },
  });
  registry.register({
    id: 'publish_page',
    risk: 'high',
    schema: { slug: { type: 'string', required: true } },
    handler: (params) => {
      calls.publish_page += 1;
      return { url: `/p/${params.slug}` };
    },
  });
  registry.register({
    id: 'unlisted_tool',
    risk: 'low',
    schema: {},
    handler: () => {
      calls.unlisted_tool += 1;
      return {};
    },
  });
  const engine = createRunEngine({ registry, store, audit: sink, sleep: async () => {} });
  return { engine, gate, calls, store };
}

async function startedRun(engine) {
  const created = await engine.createRun({ companyId: CO, team: makeTeam(), budget: { maxTokens: 1000, maxToolCalls: 10 } });
  assert.equal(created.ok, true, created.reason);
  const started = await engine.startRun(CO, created.run.id);
  assert.equal(started.ok, true);
  return started.run.id;
}

const ACTOR = { kind: 'agent', agentId: 'booker-1', roleId: 'booker' };
const readSpec = { toolId: 'read_note', description: 'Read a note', parameters: z.object({ slug: z.string() }) };
const publishSpec = { toolId: 'publish_page', description: 'Publish a page', parameters: z.object({ slug: z.string() }) };

// ---------- tests ----------

test('a bridged call reaches engine.callTool with the same companyId, runId, toolId and params', async () => {
  const { engine, calls } = setup();
  const runId = await startedRun(engine);
  const seen = [];
  const recording = {
    ...engine,
    callTool: (companyId, id, call) => {
      seen.push({ companyId, id, call });
      return engine.callTool(companyId, id, call);
    },
  };
  const [tool] = buildRegistryTools({ engine: recording, companyId: CO, runId, actor: ACTOR, tools: [readSpec], env: ON });

  const result = await tool.execute({ slug: 'home' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].companyId, CO);
  assert.equal(seen[0].id, runId);
  assert.equal(seen[0].call.toolId, 'read_note');
  assert.deepEqual(seen[0].call.params, { slug: 'home' });
  assert.deepEqual(seen[0].call.actor, ACTOR);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'executed');
  assert.deepEqual(result.output, { slug: 'home', body: 'hello' });
  assert.equal(calls.read_note, 1);
});

test('an unlisted registry tool is not exposed', async () => {
  const { engine } = setup();
  const runId = await startedRun(engine);
  const tools = buildRegistryTools({ engine, companyId: CO, runId, actor: ACTOR, tools: [readSpec], env: ON });

  assert.deepEqual(tools.map((t) => t.id), ['read_note']);
  assert.equal(tools.some((t) => t.id === 'unlisted_tool' || t.name === 'unlisted_tool'), false);
  assert.equal(tools.some((t) => t.id === 'publish_page'), false);
});

test('a high-risk call with no approval is stopped by the engine and the handler does not run', async () => {
  const { engine, gate, calls } = setup();
  const runId = await startedRun(engine);
  const [tool] = buildRegistryTools({ engine, companyId: CO, runId, actor: ACTOR, tools: [publishSpec], env: ON });

  const result = await tool.execute({ slug: 'home' });

  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'awaiting_approval');
  assert.equal(result.toolId, 'publish_page');
  assert.equal(typeof result.approvalId, 'string');
  assert.equal(gate.approvals.get(result.approvalId).status, 'pending');
  assert.equal(calls.publish_page, 0);
});

test('with VOLTAGENT_AGENTS_ENABLED unset the bridge refuses to build tools', async () => {
  const { engine } = setup();
  const runId = await startedRun(engine);
  const base = { engine, companyId: CO, runId, actor: ACTOR, tools: [readSpec] };

  assert.throws(() => buildRegistryTools({ ...base, env: {} }), (error) => error.message === VOLTAGENT_AGENTS_DISABLED_MESSAGE);
  assert.throws(() => buildRegistryTools({ ...base, env: { VOLTAGENT_AGENTS_ENABLED: 'TRUE' } }));
  assert.throws(() => buildRegistryTools({ ...base, env: { VOLTAGENT_AGENTS_ENABLED: '1' } }));
  assert.equal(buildRegistryTools({ ...base, env: ON }).length, 1);
});

test('a listed tool id twice is refused', async () => {
  const { engine } = setup();
  const runId = await startedRun(engine);
  assert.throws(
    () => buildRegistryTools({ engine, companyId: CO, runId, actor: ACTOR, tools: [readSpec, readSpec], env: ON }),
    /listed twice/,
  );
});
