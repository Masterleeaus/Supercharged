// Checklist 6: read and list queries on the flow-automation, incoming-connections and twilio-openai
// incoming-connection routes must filter by the session company as well as the user, and refuse
// with 403 when the company is missing.
//
// Two parts:
//  1. Static scan (TypeScript AST) of the three route files. Every select on a company-owned table
//     must reference companyId in its statement, or in the array of conditions it uses.
//  2. Fake-request tests of the real server/middleware/company-scope.ts. The route modules cannot be
//     loaded under --experimental-transform-types (server/middleware/auth.ts value-imports express
//     types), so the behaviour of the helper is tested directly with fake req and res objects.
//
// Run: node --test --experimental-transform-types tests/security/company-read-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// Keep stdout clean: the test runner reads IPC on stdout.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { getCompanyScope, requireCompanyScope, CompanyScopeError } = await import('../../server/middleware/company-scope.ts');

const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');

// The flow routes are split: the entry file plus every module under server/routes/flow-automation/.
const FLOW_FILES = [
  'server/routes/flow-automation-routes.ts',
  ...fs.readdirSync(new URL('server/routes/flow-automation/', root))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `server/routes/flow-automation/${f}`),
];
const flowSource = FLOW_FILES.map(read).join('\n');
const sourceOf = (rel) => (FLOW_FILES.includes(rel) ? flowSource : read(rel));

const ROUTE_FILES = [
  ...FLOW_FILES,
  'server/routes/incoming-connections-routes.ts',
  'server/engines/twilio-openai/routes/twilio-openai-incoming-connections.ts',
];

// Tables with a company_id column in shared/schema.ts that these routes read.
const SCOPED_TABLES = new Set([
  'flows', 'flowExecutions', 'flowTestQueue', 'webhooks', 'webhookLogs', 'appointments',
  'appointmentSettings', 'forms', 'formFields', 'formSubmissions', 'incomingConnections',
  'campaigns', 'phoneNumbers', 'plivoPhoneNumbers', 'sipPhoneNumbers', 'calls', 'contacts',
  'agents', 'twilioOpenaiCalls', 'plivoCalls', 'sipCalls',
]);

// Raw SQL reads (db.execute) on plugin tables that have no company_id in shared/schema.ts are
// outside the scan. They are reported in the task report, not silently passed.

function enclosingStatement(node) {
  let n = node;
  while (n && !ts.isStatement(n) && !ts.isFunctionLike(n)) n = n.parent;
  return n;
}

function enclosingFunction(node) {
  let n = node.parent;
  while (n && !ts.isFunctionLike(n)) n = n.parent;
  return n;
}

// The where argument of the chain that contains this from(...) call, as text.
function whereArgText(fromCall) {
  let n = fromCall.parent;
  while (n && !(ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'where')) {
    if (ts.isStatement(n)) return null;
    n = n.parent;
  }
  return n ? n.arguments[0] : null;
}

// Does a local identifier used in the where clause get its companyId from its initializer?
function identifierInitializerMentionsCompany(sf, fn, name) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      if (node.initializer.getText(sf).includes('companyId')) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn ?? sf);
  return found;
}

function scanReads(rel) {
  const text = read(rel);
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
  const reads = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'from' &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]) &&
      SCOPED_TABLES.has(node.arguments[0].text)
    ) {
      const table = node.arguments[0].text;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const stmt = enclosingStatement(node);
      const stmtText = stmt ? stmt.getText(sf) : '';
      let scoped = stmtText.includes('companyId');
      if (!scoped) {
        const where = whereArgText(node);
        if (where && ts.isIdentifier(where)) {
          scoped = identifierInitializerMentionsCompany(sf, enclosingFunction(node), where.text);
        } else if (where && ts.isCallExpression(where) && where.arguments.length === 1 && ts.isSpreadElement(where.arguments[0])) {
          const spread = where.arguments[0].expression;
          if (ts.isIdentifier(spread)) scoped = identifierInitializerMentionsCompany(sf, enclosingFunction(node), spread.text);
        }
      }
      reads.push({ table, line, scoped });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return reads;
}

test('every select on a company-owned table in the three route files filters by companyId', () => {
  const unscoped = [];
  let total = 0;
  for (const rel of ROUTE_FILES) {
    const reads = scanReads(rel);
    total += reads.length;
    for (const r of reads) if (!r.scoped) unscoped.push(`${rel}:${r.line} from(${r.table})`);
  }
  assert.ok(total >= 93, `scan must see the real read sites (found ${total})`);
  assert.deepEqual(unscoped, [], `unscoped reads:\n${unscoped.join('\n')}`);
});

test('each route file defines a company helper that reads the verified session and refuses with 403', () => {
  for (const rel of ROUTE_FILES) {
    const src = sourceOf(rel);
    assert.match(src, /getCompanyScope\(req\)/, `${rel} must read company from the session`);
    assert.doesNotMatch(src, /req\.body\.companyId|req\.query\.companyId|req\.params\.companyId/, `${rel} must not take company from the request`);
  }
  for (const rel of ['server/routes/flow-automation-routes.ts', 'server/routes/incoming-connections-routes.ts']) {
    const src = sourceOf(rel);
    assert.match(src, /function companyForRead\(req: AuthRequest, res: Response\): string \| null/, `${rel} must define companyForRead`);
    assert.match(src, /res\.status\(403\)\.json\(\{ error: "Company scope required" \}\)/, `${rel} must return 403 when company is missing`);
  }
});

test('getCompanyScope returns the company from the verified session user only', () => {
  const CO_A = '11111111-1111-4111-8111-111111111111';
  const CO_B = '22222222-2222-4222-8222-222222222222';
  // The session belongs to company A. Company B is only in the body, query and params.
  const req = { user: { userId: 'u-a', companyId: CO_A }, body: { companyId: CO_B }, query: { companyId: CO_B }, params: { companyId: CO_B }, headers: { 'x-company-id': CO_B } };
  assert.equal(getCompanyScope(req), CO_A);
});

test('getCompanyScope throws when the session has no company or an invalid one (fail closed)', () => {
  assert.throws(() => getCompanyScope({ user: { userId: 'u-x' } }), CompanyScopeError);
  assert.throws(() => getCompanyScope({ user: { userId: 'u-x', companyId: '' } }), CompanyScopeError);
  assert.throws(() => getCompanyScope({ user: { userId: 'u-x', companyId: 'not-a-uuid' } }), CompanyScopeError);
  assert.throws(() => getCompanyScope({}), CompanyScopeError);
});

function fakeRes() {
  const res = { statusCode: 200, body: undefined, locals: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

test('requireCompanyScope refuses with 403 and does not call next when company is missing', () => {
  const guard = requireCompanyScope();
  const res = fakeRes();
  let called = false;
  guard({ user: { userId: 'u-x' } }, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Company scope required' });
});

test('requireCompanyScope sets res.locals.companyId from the session only', () => {
  const CO_A = '11111111-1111-4111-8111-111111111111';
  const CO_B = '22222222-2222-4222-8222-222222222222';
  const guard = requireCompanyScope();
  const res = fakeRes();
  let called = false;
  guard({ user: { userId: 'u-a', companyId: CO_A }, body: { companyId: CO_B } }, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.locals.companyId, CO_A);
});
