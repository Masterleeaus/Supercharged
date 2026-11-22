import test from 'node:test';
import assert from 'node:assert/strict';

const { loadCompanyHealth } = await import('../../server/connectors/admin/company-health.ts');
const { createMemoryStateStore } = await import('../../server/connectors/admin/state.ts');
const { toHealthRows } = await import('../../server/connectors/admin/health-rows.ts');

const CO1 = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-18T12:00:00Z';

function registryWith(ids) {
  return {
    registered: () => ids.map((id) => ({ manifest: { id, vendor: `Vendor ${id}` }, definition: {} })),
  };
}

function settingsWith(map) {
  return {
    async get(c, id) {
      return map[`${c}:${id}`] ?? null;
    },
    async set() {},
  };
}

test('loadCompanyHealth lists every registered connector for the company, worst first', async () => {
  const state = createMemoryStateStore();
  await state.update(CO1, 'crm', (s) => ({ ...s, lastErrorCode: 'auth_failed', errorCount: 2 }));
  const healths = await loadCompanyHealth(
    {
      registry: registryWith(['crm', 'calendar']),
      settings: settingsWith({ [`${CO1}:crm`]: { enabled: true, config: {} }, [`${CO1}:calendar`]: { enabled: true, config: {} } }),
      state,
      isConnected: async () => true,
    },
    CO1,
    NOW,
  );
  assert.equal(healths.length, 2);
  assert.equal(healths[0].connectorId, 'crm');
  assert.equal(healths[0].state, 'failing');
  assert.equal(healths[0].errorCount, 2);
});

test('a connector with no credentials is reported as not connected, never healthy', async () => {
  const healths = await loadCompanyHealth(
    {
      registry: registryWith(['crm']),
      settings: settingsWith({}),
      state: createMemoryStateStore(),
      isConnected: async () => false,
    },
    CO1,
    NOW,
  );
  assert.equal(healths[0].state, 'not_connected');
});

test('dead letters and token expiry from the optional lookups reach the health model', async () => {
  const healths = await loadCompanyHealth(
    {
      registry: registryWith(['crm']),
      settings: settingsWith({ [`${CO1}:crm`]: { enabled: true, config: {} } }),
      state: createMemoryStateStore(),
      isConnected: async () => true,
      deadLetterCount: async () => 3,
      tokenExpiresAt: async () => '2026-11-18T13:00:00Z',
    },
    CO1,
    NOW,
  );
  assert.equal(healths[0].deadLetterCount, 3);
  assert.equal(healths[0].tokenExpiresAt, '2026-11-18T13:00:00Z');
  assert.equal(healths[0].state, 'attention');
});

test('company scope: company two state never leaks into company one health', async () => {
  const state = createMemoryStateStore();
  await state.update(CO2, 'crm', (s) => ({ ...s, lastErrorCode: 'auth_failed', errorCount: 5 }));
  const healths = await loadCompanyHealth(
    {
      registry: registryWith(['crm']),
      settings: settingsWith({ [`${CO1}:crm`]: { enabled: true, config: {} } }),
      state,
      isConnected: async () => true,
    },
    CO1,
    NOW,
  );
  assert.equal(healths[0].errorCount, 0);
  assert.equal(healths[0].state, 'attention', 'company one has never synced, so it needs attention, not failing');
  assert.ok(!healths[0].problems.some((p) => p.code === 'auth_failed'));
});

test('toHealthRows gives one row per connector with state label, tone, facts and fixes', async () => {
  const healths = await loadCompanyHealth(
    {
      registry: registryWith(['crm']),
      settings: settingsWith({ [`${CO1}:crm`]: { enabled: true, config: {} } }),
      state: createMemoryStateStore(),
      isConnected: async () => true,
      deadLetterCount: async () => 1,
    },
    CO1,
    NOW,
  );
  const [row] = toHealthRows(healths);
  assert.equal(row.title, 'Vendor crm');
  assert.equal(row.stateLabel, 'Needs attention');
  assert.equal(row.tone, 'warn');
  assert.ok(row.facts.includes('Dead letters: 1'));
  assert.ok(row.facts.includes('Last successful sync: never'));
  assert.ok(row.facts.includes('Token expires: no expiry on record'));
  assert.ok(row.problems.length > 0);
  for (const p of row.problems) {
    assert.ok(p.message && p.fix, 'every problem has a message and a fix');
  }
});

test('toHealthRows maps every state to a label and a tone, with no empty values', () => {
  const states = ['failing', 'attention', 'paused', 'not_connected', 'healthy'];
  const rows = toHealthRows(
    states.map((state, i) => ({
      connectorId: `c${i}`,
      displayName: `C${i}`,
      state,
      lastSuccessAt: null,
      errorCount: 0,
      deadLetterCount: 0,
      tokenExpiresAt: null,
      problems: [],
    })),
  );
  for (const row of rows) {
    assert.ok(row.stateLabel.length > 0);
    assert.ok(['ok', 'warn', 'bad', 'muted'].includes(row.tone));
  }
  assert.equal(rows.find((r) => r.connectorId === 'c4').tone, 'ok');
  assert.equal(rows.find((r) => r.connectorId === 'c0').tone, 'bad');
});
