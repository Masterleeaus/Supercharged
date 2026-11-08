import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Same zod fallback as tests/workforce/roster.test.mjs.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const loader = await import('../../server/workforce/catalogue/loader.ts');
const inMemory = await import('../../server/workforce/roster.ts');
const pgRoster = await import('../../server/workforce/pg-roster.ts');

const rolesDir = fileURLToPath(new URL('../../server/workforce/catalogue/roles/', import.meta.url));
const catalogue = await loader.loadRoleCatalogue(rolesDir);

// Real roles. appointment-reminder: autonomy auto, channels sms and email, tool booking_requests.list.
// compliance-expiry-tracker: autonomy suggest, channels email only.
const AUTO_ROLE = 'appointment-reminder';
const SUGGEST_ROLE = 'compliance-expiry-tracker';

const CO_A = '6f1c2e3a-1111-4a5b-8c9d-00000000000a';
const CO_B = '6f1c2e3a-2222-4a5b-8c9d-00000000000b';

function base(overrides = {}) {
  return {
    companyId: CO_A,
    roleId: AUTO_ROLE,
    agentId: 'agent-1',
    teamId: 'team-north',
    channels: ['sms'],
    permissions: ['booking_requests.list'],
    autonomy: 'auto',
    ...overrides,
  };
}

// In-memory fake of workforce_agents. It answers only the statements pg-roster.ts issues, applies the same
// WHERE clauses (company_id, id, status <> 'retired') and records every call so tests can check the SQL
// text and the tenant key passed as the first value.
function createFakeDb() {
  const rows = new Map(); // `${company}|${id}` -> row
  const calls = [];
  const key = (company, id) => `${company}|${id}`;

  return {
    calls,
    rows,
    async query(text, values) {
      calls.push({ text, values: [...values] });
      const sql = text.replace(/\s+/g, ' ').trim();

      if (sql.startsWith('SELECT') && sql.includes('WHERE company_id = $1 AND id = $2')) {
        const [company, id] = values;
        const row = rows.get(key(company, id));
        return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
      }

      if (sql.startsWith('SELECT') && sql.includes('WHERE company_id = $1 ORDER BY')) {
        const [company] = values;
        const found = [...rows.values()]
          .filter((r) => r.company_id === company)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
          .map((r) => structuredClone(r));
        return { rows: found, rowCount: found.length };
      }

      if (sql.startsWith('INSERT INTO workforce_agents')) {
        const [id, company, role, team, channels, permissions, autonomy, status, createdAt] = values;
        if (rows.has(key(company, id))) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
        const row = {
          id, company_id: company, role_id: role, team_id: team,
          channels: JSON.parse(channels), permissions: JSON.parse(permissions),
          autonomy, status, created_at: createdAt, updated_at: createdAt,
        };
        rows.set(key(company, id), row);
        return { rows: [structuredClone(row)], rowCount: 1 };
      }

      if (sql.startsWith('UPDATE workforce_agents SET team_id')) {
        const [company, id, team, channels, permissions, autonomy, updatedAt] = values;
        const row = rows.get(key(company, id));
        if (!row || row.status === 'retired') return { rows: [], rowCount: 0 };
        Object.assign(row, {
          team_id: team, channels: JSON.parse(channels), permissions: JSON.parse(permissions),
          autonomy, updated_at: updatedAt,
        });
        return { rows: [structuredClone(row)], rowCount: 1 };
      }

      if (sql.startsWith('UPDATE workforce_agents SET status')) {
        const [company, id, status, updatedAt] = values;
        const row = rows.get(key(company, id));
        if (!row || row.status === 'retired') return { rows: [], rowCount: 0 };
        Object.assign(row, { status, updated_at: updatedAt });
        return { rows: [structuredClone(row)], rowCount: 1 };
      }

      throw new Error(`fake db: unexpected statement: ${sql}`);
    },
  };
}

function makeRoster(db, now) {
  return pgRoster.createPgRoster({ db, catalogue, now });
}

const UNKNOWN_CO = '6f1c2e3a-3333-4a5b-8c9d-00000000000c';

// Wraps a fake db so the first conditional UPDATE finds the agent already retired, as if a concurrent
// call committed the retirement between this call's read and its write.
function retireOnFirstUpdate(db) {
  let fired = false;
  return {
    calls: db.calls,
    async query(text, values) {
      if (!fired && text.includes('UPDATE workforce_agents SET')) {
        fired = true;
        const row = db.rows.get(`${CO_A}|agent-1`);
        if (row) row.status = 'retired';
      }
      return db.query(text, values);
    },
  };
}

test('create stores an active agent from a real role and returns it', async () => {
  const db = createFakeDb();
  const r = makeRoster(db);
  const result = await r.createAgent(base());
  assert.equal(result.ok, true);
  assert.equal(result.agent.companyId, CO_A);
  assert.equal(result.agent.agentId, 'agent-1');
  assert.equal(result.agent.roleId, AUTO_ROLE);
  assert.equal(result.agent.teamId, 'team-north');
  assert.deepEqual([...result.agent.channels], ['sms']);
  assert.deepEqual([...result.agent.permissions], ['booking_requests.list']);
  assert.equal(result.agent.autonomy, 'auto');
  assert.equal(result.agent.status, 'active');

  const stored = db.rows.get(`${CO_A}|agent-1`);
  assert.deepEqual(stored.channels, ['sms'], 'channels are stored as jsonb');
  assert.deepEqual(stored.permissions, ['booking_requests.list']);
});

test('autonomy above the role maximum is refused; equal or lower is accepted; invalid tiers refused', async () => {
  const r = makeRoster(createFakeDb());
  assert.equal((await r.createAgent(base({ autonomy: 'predictive' }))).reason, 'autonomy_exceeds_role');
  assert.equal((await r.createAgent(base({ roleId: SUGGEST_ROLE, channels: ['email'], autonomy: 'auto' }))).reason, 'autonomy_exceeds_role');
  assert.equal((await r.createAgent(base({ agentId: 'a2', autonomy: 'auto' }))).ok, true);
  assert.equal((await r.createAgent(base({ agentId: 'a3', autonomy: 'assist' }))).ok, true);
  assert.equal((await r.createAgent(base({ agentId: 'a4', autonomy: 'turbo' }))).reason, 'invalid_autonomy');
});

test('a channel the role does not allow is refused on create and on configure, and a refused patch changes nothing', async () => {
  const db = createFakeDb();
  const r = makeRoster(db);
  assert.equal((await r.createAgent(base({ channels: ['voice'] }))).reason, 'channel_not_allowed');
  assert.equal((await r.createAgent(base())).ok, true);
  assert.equal((await r.configureAgent(CO_A, 'agent-1', { channels: ['sms', 'whatsapp'] })).reason, 'channel_not_allowed');
  assert.equal((await r.configureAgent(CO_A, 'agent-1', { channels: ['sms', 'sms'] })).reason, 'invalid_input');
  const [listed] = await r.listAgents(CO_A);
  assert.deepEqual([...listed.channels], ['sms'], 'refused patch changes nothing');
});

test('a permission that is not a tool of the role is refused', async () => {
  const r = makeRoster(createFakeDb());
  assert.equal((await r.createAgent(base({ permissions: ['payments.refund'] }))).reason, 'permission_not_allowed');
});

test('an unknown role is refused before any write', async () => {
  const db = createFakeDb();
  const r = makeRoster(db);
  const result = await r.createAgent(base({ roleId: 'no-such-role' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_role');
  assert.equal(db.calls.some((c) => c.text.includes('INSERT')), false, 'no insert was issued');
  assert.deepEqual(await r.listAgents(CO_A), []);
});

test('the same agent id is allowed in two companies but not twice in one, including a lost insert race', async () => {
  const db = createFakeDb();
  const r = makeRoster(db);
  assert.equal((await r.createAgent(base())).ok, true);
  assert.equal((await r.createAgent(base({ companyId: CO_B }))).ok, true);
  assert.equal((await r.createAgent(base())).reason, 'duplicate_agent');

  // A concurrent create that passed the pre-check but lost the insert gets the same answer.
  const racing = {
    async query(text, values) {
      if (text.includes('INSERT INTO workforce_agents')) return { rows: [], rowCount: 0 };
      return db.query(text, values);
    },
  };
  const raced = makeRoster(racing);
  assert.equal((await raced.createAgent(base({ agentId: 'agent-x' }))).reason, 'duplicate_agent');
});

test('configure applies a valid patch and refuses changing companyId, roleId or agentId', async () => {
  const r = makeRoster(createFakeDb());
  await r.createAgent(base());

  const ok = await r.configureAgent(CO_A, 'agent-1', { autonomy: 'assist', teamId: 'team-south' });
  assert.equal(ok.ok, true);
  assert.equal(ok.agent.autonomy, 'assist');
  assert.equal(ok.agent.teamId, 'team-south');
  assert.deepEqual([...ok.agent.channels], ['sms'], 'unpatched fields keep their stored values');

  assert.equal((await r.configureAgent(CO_A, 'agent-1', { companyId: CO_B })).reason, 'immutable_field');
  assert.equal((await r.configureAgent(CO_A, 'agent-1', { roleId: SUGGEST_ROLE })).reason, 'immutable_field');
  assert.equal((await r.configureAgent(CO_A, 'agent-1', { agentId: 'other' })).reason, 'immutable_field');
  assert.equal((await r.configureAgent(CO_A, 'agent-1', { nickname: 'x' })).reason, 'invalid_input');
  assert.equal((await r.listAgents(CO_A))[0].roleId, AUTO_ROLE);
});

test('pause and resume move an agent between active and paused; an unknown status is refused without a query', async () => {
  const db = createFakeDb();
  const r = makeRoster(db);
  await r.createAgent(base());
  assert.equal((await r.setAgentStatus(CO_A, 'agent-1', 'paused')).agent.status, 'paused');
  assert.equal((await r.setAgentStatus(CO_A, 'agent-1', 'active')).agent.status, 'active');

  const before = db.calls.length;
  assert.equal((await r.setAgentStatus(CO_A, 'agent-1', 'deleted')).reason, 'invalid_status');
  assert.equal(db.calls.length, before, 'invalid status issues no query');
});

test('retired is terminal: no status change and no configure, and the agent stays listed', async () => {
  const r = makeRoster(createFakeDb());
  await r.createAgent(base());
  assert.equal((await r.setAgentStatus(CO_A, 'agent-1', 'retired')).agent.status, 'retired');

  for (const status of ['active', 'paused', 'retired']) {
    assert.equal((await r.setAgentStatus(CO_A, 'agent-1', status)).reason, 'agent_retired', status);
  }
  assert.equal((await r.configureAgent(CO_A, 'agent-1', { autonomy: 'assist' })).reason, 'agent_retired');

  const listed = await r.listAgents(CO_A);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'retired');
});

test('a retirement that commits after the read is still terminal: the conditional write matches no row', async () => {
  for (const attempt of ['status', 'configure']) {
    const db = createFakeDb();
    const seeded = makeRoster(db);
    await seeded.createAgent(base());
    const raced = makeRoster(retireOnFirstUpdate(db));
    const result = attempt === 'status'
      ? await raced.setAgentStatus(CO_A, 'agent-1', 'paused')
      : await raced.configureAgent(CO_A, 'agent-1', { autonomy: 'assist' });
    assert.equal(result.reason, 'agent_retired', attempt);
    assert.equal(db.rows.get(`${CO_A}|agent-1`).status, 'retired', attempt);
  }
});

test('company isolation: list returns only that company, cross-company writes find nothing, every query is scoped', async () => {
  const db = createFakeDb();
  const r = makeRoster(db);
  await r.createAgent(base({ agentId: 'a-only-a' }));
  await r.createAgent(base({ companyId: CO_B, agentId: 'b-only-b' }));

  assert.deepEqual((await r.listAgents(CO_A)).map((a) => a.agentId), ['a-only-a']);
  assert.deepEqual((await r.listAgents(CO_B)).map((a) => a.agentId), ['b-only-b']);
  assert.deepEqual(await r.listAgents(''), []);
  assert.deepEqual(await r.listAgents(UNKNOWN_CO), []);

  assert.equal((await r.configureAgent(CO_B, 'a-only-a', { autonomy: 'assist' })).reason, 'agent_not_found');
  assert.equal((await r.setAgentStatus(CO_B, 'a-only-a', 'paused')).reason, 'agent_not_found');
  assert.equal((await r.configureAgent('', 'a-only-a', { autonomy: 'assist' })).reason, 'agent_not_found');

  const [stillA] = await r.listAgents(CO_A);
  assert.equal(stillA.autonomy, 'auto');
  assert.equal(stillA.status, 'active');

  for (const call of db.calls) {
    // INSERT takes the agent id first and the company second; every other statement takes the company first.
    const company = call.text.startsWith('INSERT') ? call.values[1] : call.values[0];
    assert.ok([CO_A, CO_B, UNKNOWN_CO].includes(company), `statement is scoped to a company id: ${company}`);
    if (!call.text.startsWith('INSERT')) {
      assert.match(call.text, /company_id = \$1/, 'every read and update filters on company_id');
    }
  }
});

test('agents survive a restart: a new roster over the same database sees the earlier agents', async () => {
  const db = createFakeDb();
  await makeRoster(db).createAgent(base());
  await makeRoster(db).setAgentStatus(CO_A, 'agent-1', 'paused');

  const afterRestart = makeRoster(db);
  const [agent] = await afterRestart.listAgents(CO_A);
  assert.equal(agent.agentId, 'agent-1');
  assert.equal(agent.status, 'paused');
});

test('listed agents are frozen copies, and no operation changes the catalogue', async () => {
  const before = JSON.stringify([...catalogue.values()]);
  const r = makeRoster(createFakeDb());
  const created = await r.createAgent(base());
  await r.configureAgent(CO_A, 'agent-1', { channels: ['sms'], permissions: [] });
  const [listed] = await r.listAgents(CO_A);
  assert.throws(() => listed.channels.push('email'), TypeError);
  assert.equal(created.agent.channels.length, 1);
  assert.equal(JSON.stringify([...catalogue.values()]), before);
});

// Parity: the same scenario run against the in-memory roster and the pg roster gives the same outcomes.
test('parity with roster.ts: the same scenario gives the same reasons and statuses', async () => {
  const scenario = [
    ['create', base()],
    ['create', base({ autonomy: 'predictive' })],
    ['create', base({ roleId: 'no-such-role' })],
    ['create', base({ channels: ['voice'] })],
    ['create', base({ permissions: ['payments.refund'] })],
    ['create', base()],
    ['create', base({ companyId: CO_B })],
    ['configure', CO_A, 'agent-1', { autonomy: 'assist' }],
    ['configure', CO_A, 'agent-1', { roleId: SUGGEST_ROLE }],
    ['configure', CO_A, 'agent-1', { channels: ['whatsapp'] }],
    ['configure', CO_B, 'agent-1', { autonomy: 'assist' }],
    ['status', CO_A, 'agent-1', 'paused'],
    ['status', CO_A, 'agent-1', 'bogus'],
    ['status', CO_A, 'agent-1', 'retired'],
    ['status', CO_A, 'agent-1', 'active'],
    ['configure', CO_A, 'agent-1', { autonomy: 'assist' }],
  ];

  const memory = inMemory.createRoster(catalogue);
  const pg = makeRoster(createFakeDb());
  const memoryOut = [];
  const pgOut = [];

  for (const step of scenario) {
    const [op, ...args] = step;
    let m;
    let p;
    if (op === 'create') {
      m = inMemory.createAgent(memory, args[0]);
      p = await pg.createAgent(args[0]);
    } else if (op === 'configure') {
      m = inMemory.configureAgent(memory, args[0], args[1], args[2]);
      p = await pg.configureAgent(args[0], args[1], args[2]);
    } else {
      m = inMemory.setAgentStatus(memory, args[0], args[1], args[2]);
      p = await pg.setAgentStatus(args[0], args[1], args[2]);
    }
    memoryOut.push(m.ok ? `ok:${m.agent.status}` : m.reason);
    pgOut.push(p.ok ? `ok:${p.agent.status}` : p.reason);
  }

  assert.deepEqual(pgOut, memoryOut);
  assert.equal(pgOut.at(-1), 'agent_retired');
});

test('getAgent is scoped to the company: another company or an unknown id finds nothing, and no write happens', async () => {
  const db = createFakeDb();
  const r = makeRoster(db);
  await r.createAgent(base());
  const found = await r.getAgent(CO_A, 'agent-1');
  assert.equal(found.agentId, 'agent-1');
  assert.equal(found.status, 'active');
  assert.equal(await r.getAgent(CO_B, 'agent-1'), undefined);
  assert.equal(await r.getAgent(UNKNOWN_CO, 'agent-1'), undefined);
  assert.equal(await r.getAgent(CO_A, ''), undefined);
  assert.equal(db.calls.filter((c) => c.text.startsWith('INSERT') || c.text.startsWith('UPDATE')).length, 1);
});
