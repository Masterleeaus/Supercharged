// Security regression test: every insert into calls, appointments, form_submissions or flow_executions
// in the listed files must carry company_id, sourced from the verified session or the owning record,
// and must sit behind a refusal guard. Never from the request body, query or params.
// Static checks on source text, plus fake-request checks of getCompanyScope (no db, no network).
// Run: node --test --experimental-transform-types tests/security/insert-company-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Silence logging: these modules log on use, and test output must not reach stdout.
for (const m of ['log', 'info', 'warn', 'error']) console[m] = () => {};

const ROOT = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

const FILES = {
  webhook: 'server/routes/webhook-routes.ts',
  widget: 'server/modules/widget/public-widget-routes.ts',
  plivo: 'server/engines/plivo/services/openai-agent-factory.ts',
  twilio: 'server/engines/twilio-openai/services/openai-agent-factory.ts',
};

// Expected insert counts. A file that drops below these counts fails, so the checks cannot pass vacuously.
const EXPECTED = {
  [FILES.webhook]: { drizzle: 6, raw: 3 },
  [FILES.widget]: { drizzle: 2, raw: 0 },
  [FILES.plivo]: { drizzle: 4, raw: 0 },
  [FILES.twilio]: { drizzle: 2, raw: 0 },
};

const TABLE_RE = /\.insert\((calls|appointments|formSubmissions|flowExecutions)\)/g;
const RAW_RE = /INSERT INTO (calls|appointments|form_submissions|flow_executions)\s*\(/g;

// Returns the text between the open bracket at `openIdx` and its matching close bracket. Handles ( and { only.
function balancedFrom(src, openIdx) {
  const open = src[openIdx];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  throw new Error('unbalanced brackets');
}

// Drizzle insert sites: the .values(...) argument that follows .insert(<table>).
// When the argument is a named variable, the object literal assigned to that variable is used instead.
function drizzleSites(src) {
  return [...src.matchAll(TABLE_RE)].map((m) => {
    const valuesIdx = src.indexOf('.values(', m.index);
    const openIdx = valuesIdx + '.values'.length;
    let block = balancedFrom(src, openIdx).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(block)) {
      const decl = new RegExp(`const\\s+${block}\\s*=\\s*\\{`).exec(src.slice(0, m.index));
      assert.ok(decl, `values variable ${block} for ${m[1]} insert has no object literal declaration`);
      block = balancedFrom(src, decl.index + decl[0].length - 1);
    }
    return { table: m[1], index: m.index, block };
  });
}

// Raw SQL insert sites: the column list of INSERT INTO calls (...).
function rawSites(src) {
  return [...src.matchAll(RAW_RE)].map((m) => {
    const openIdx = m.index + m[0].length - 1;
    return { table: m[1], index: m.index, block: balancedFrom(src, openIdx) };
  });
}

// The nearest preceding refusal guard on a company variable must exist: `if (!<...CompanyId>) { ... return ... }`.
// Each insert in these files has its own guard placed just above it, so the nearest guard is the one that applies.
function hasRefusalGuardBefore(src, index) {
  const re = /if \(!\s*\w*[cC]ompanyId\s*\)\s*\{[\s\S]{0,400}?\breturn\b/g;
  let last = null;
  for (const m of src.slice(0, index).matchAll(re)) last = m;
  return last !== null;
}

const BODY_COMPANY = [
  /\breq\??\.(body|query|params)\??\.companyId\b/,
  /\breq\??\.(body|query|params)\??\[\s*['"`]companyId['"`]\s*\]/,
  /\{[^}]*\bcompanyId\b[^}]*\}\s*=\s*req\??\.(body|query|params)\b/,
];

for (const file of Object.values(FILES)) {
  test(`${file}: every drizzle insert into a tenant table sets companyId`, () => {
    const src = read(file);
    const sites = drizzleSites(src);
    assert.ok(sites.length >= EXPECTED[file].drizzle, `expected >= ${EXPECTED[file].drizzle} drizzle inserts, found ${sites.length}`);
    for (const site of sites) {
      const line = src.slice(0, site.index).split('\n').length;
      assert.match(site.block, /\bcompanyId\b/, `${file}:${line} insert into ${site.table} has no companyId`);
      assert.ok(hasRefusalGuardBefore(src, site.index), `${file}:${line} insert into ${site.table} has no refusal guard before it`);
    }
  });

  test(`${file}: every raw SQL insert into a tenant table sets company_id`, () => {
    const src = read(file);
    const sites = rawSites(src);
    assert.equal(sites.length, EXPECTED[file].raw, `expected ${EXPECTED[file].raw} raw inserts, found ${sites.length}`);
    for (const site of sites) {
      const line = src.slice(0, site.index).split('\n').length;
      assert.match(site.block, /\bcompany_id\b/, `${file}:${line} raw insert into ${site.table} has no company_id`);
      assert.ok(hasRefusalGuardBefore(src, site.index), `${file}:${line} raw insert into ${site.table} has no refusal guard before it`);
    }
  });

  test(`${file}: companyId is never read from request input`, () => {
    const src = read(file);
    for (const pattern of BODY_COMPANY) {
      assert.doesNotMatch(src, pattern, `${file} must take companyId from the session or the owning record`);
    }
  });
}

// Fake-request checks of the session-scope helper that the routes use. No db is loaded.
const { getCompanyScope, CompanyScopeError } = await import(new URL('server/middleware/company-scope.ts', ROOT).href);

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';

test('getCompanyScope returns the company from the verified user', () => {
  assert.equal(getCompanyScope({ user: { companyId: COMPANY_A } }), COMPANY_A);
});

test('getCompanyScope ignores a companyId sent in body, query or params', () => {
  const req = { user: undefined, body: { companyId: COMPANY_B }, query: { companyId: COMPANY_B }, params: { companyId: COMPANY_B } };
  assert.throws(() => getCompanyScope(req), CompanyScopeError);
});

test('getCompanyScope prefers the verified user over a conflicting body value', () => {
  const req = { user: { companyId: COMPANY_A }, body: { companyId: COMPANY_B } };
  assert.equal(getCompanyScope(req), COMPANY_A);
});

test('getCompanyScope fails closed when the verified user has no valid company', () => {
  assert.throws(() => getCompanyScope({ user: { companyId: 'not-a-uuid' } }), CompanyScopeError);
  assert.throws(() => getCompanyScope({ user: {} }), CompanyScopeError);
});
