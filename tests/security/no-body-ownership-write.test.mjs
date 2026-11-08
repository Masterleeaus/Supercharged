// Security regression test: PATCH handlers must not copy request body keys into database writes.
// A client must not be able to write companyId, userId, id or other ownership and key fields.
//
// Two parts:
//  1. Static scan (TypeScript AST) of the route files. No .set() may spread req.body, and each
//     PATCH handler must answer 400 when the body holds no editable field.
//  2. Behaviour of the real pickEditableFields helper and the real allowlists, extracted from the
//     source and transpiled. The route modules cannot be loaded under --experimental-transform-types.
//
// Run: node --test --experimental-transform-types tests/security/no-body-ownership-write.test.mjs
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
const CONNECTIONS_FILE = 'server/routes/incoming-connections-routes.ts';
const ROUTE_FILES = [...FLOW_FILES, CONNECTIONS_FILE];

const FORBIDDEN_KEYS = [
  'companyId', 'company_id', 'userId', 'user_id', 'id', 'createdAt', 'updatedAt',
  'created_at', 'updated_at', 'isTemplate', 'compiledSystemPrompt', 'compiledFirstMessage',
  'compiledStates', 'compiledTools', 'googleCalendarEventId', 'callId', 'flowId',
];

const parse = (rel) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

// Every .set({ ... }) argument in the file.
function setCallArgs(sf) {
  const out = [];
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'set') {
      for (const arg of node.arguments) out.push(arg);
    }
  });
  return out;
}

// Route handlers registered with router.patch(path, handler).
function patchHandlers(sf) {
  const out = [];
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'patch') {
      out.push({ path: node.arguments[0].getText(sf), text: node.getText(sf) });
    }
  });
  return out;
}

// Array literal of strings assigned to a const whose name ends in _EDITABLE_FIELDS.
function allowlists(sf) {
  const out = {};
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text.endsWith('_EDITABLE_FIELDS') && node.initializer) {
      let init = node.initializer;
      if (ts.isAsExpression(init)) init = init.expression;
      out[node.name.text] = init.elements.map((e) => e.text);
    }
  });
  return out;
}

// Real pickEditableFields function from the source, transpiled to JavaScript and evaluated.
function loadPicker(sfs) {
  let fnText = null;
  for (const sf of sfs) {
    walk(sf, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'pickEditableFields') {
        fnText = node.getText(sf).replace(/^export /, '');
      }
    });
  }
  assert.ok(fnText, 'pickEditableFields must be defined in the flow-automation routes');
  const js = ts.transpileModule(fnText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(`${js}\nreturn pickEditableFields;`)();
}

const flowSfs = FLOW_FILES.map(parse);
const connSf = parse(CONNECTIONS_FILE);
const lists = Object.assign({}, ...flowSfs.map(allowlists));
const picker = loadPicker(flowSfs);

test('no .set() in the route files spreads req.body', () => {
  for (const rel of ROUTE_FILES) {
    const sf = parse(rel);
    for (const arg of setCallArgs(sf)) {
      walk(arg, (node) => {
        if (ts.isSpreadAssignment(node)) {
          assert.notEqual(node.expression.getText(sf), 'req.body', `${rel} .set() must not spread req.body`);
        }
      });
    }
  }
});

test('every spread inside a PATCH handler .set() uses the validated allowlist result', () => {
  const targets = ['/flows/:id', '/webhooks/:id', '/appointments/:id'];
  const handlers = flowSfs.flatMap((sf) => patchHandlers(sf)).filter((h) => targets.some((t) => h.path.includes(t)));
  assert.equal(handlers.length, 3, 'flows, webhooks and appointments PATCH handlers');
  let spreads = 0;
  for (const flowSf of flowSfs) walk(flowSf, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'set') {
      const inPatch = targets.some((t) => {
        let n = node;
        while (n && !(ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'patch')) n = n.parent;
        return n && n.arguments[0].getText(flowSf).includes(t);
      });
      if (!inPatch) return;
      for (const arg of node.arguments) {
        walk(arg, (inner) => {
          if (ts.isSpreadAssignment(inner)) {
            spreads += 1;
            assert.equal(inner.expression.getText(flowSf), 'editable', 'PATCH .set() spread must come from pickEditableFields');
          }
        });
      }
    }
  });
  assert.equal(spreads, 3, 'each of the three PATCH handlers writes through the editable spread');
});

test('the incoming-connections POST does not spread req.body into its insert values', () => {
  walk(connSf, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'values') {
      walk(node, (inner) => {
        if (ts.isSpreadAssignment(inner)) {
          assert.notEqual(inner.expression.getText(connSf), 'req.body');
        }
      });
    }
  });
  // Company stays on the session value in the insert.
  assert.match(read(CONNECTIONS_FILE), /\.values\(\{\s*userId,\s*companyId,/);
});

test('each allowlist exists and holds no ownership or key field', () => {
  for (const name of ['FLOW_EDITABLE_FIELDS', 'WEBHOOK_EDITABLE_FIELDS', 'APPOINTMENT_EDITABLE_FIELDS']) {
    assert.ok(Array.isArray(lists[name]), `${name} must be an array literal`);
    assert.ok(lists[name].length > 0, `${name} must not be empty`);
    for (const key of FORBIDDEN_KEYS) {
      assert.ok(!lists[name].includes(key), `${name} must not allow ${key}`);
    }
  }
});

test('the allowlists keep the fields the clients send', () => {
  for (const key of ['name', 'nodes', 'edges', 'agentId', 'isActive']) assert.ok(lists.FLOW_EDITABLE_FIELDS.includes(key));
  for (const key of ['url', 'secret', 'events', 'campaignIds', 'isActive']) assert.ok(lists.WEBHOOK_EDITABLE_FIELDS.includes(key));
  for (const key of ['status', 'statusReason', 'contactName', 'appointmentDate', 'duration']) {
    assert.ok(lists.APPOINTMENT_EDITABLE_FIELDS.includes(key));
  }
});

test('every PATCH handler in the flow routes answers 400 when no editable field is present', () => {
  const handlers = flowSfs.flatMap((sf) => patchHandlers(sf));
  const targets = ['/flows/:id', '/webhooks/:id', '/appointments/:id'];
  for (const target of targets) {
    const h = handlers.find((x) => x.path.includes(target));
    assert.ok(h, `PATCH ${target} must exist`);
    assert.match(h.text, /pickEditableFields\(req\.body,/, `PATCH ${target} must use the allowlist`);
    assert.match(h.text, /res\.status\(400\)/, `PATCH ${target} must answer 400 on an empty allowlist result`);
  }
});

test('the picker copies allowed keys with their values', () => {
  const out = picker({ name: 'Flow A', nodes: [{ id: 'n1' }], isActive: false }, lists.FLOW_EDITABLE_FIELDS);
  assert.deepEqual(out, { name: 'Flow A', nodes: [{ id: 'n1' }], isActive: false });
});

test('the picker strips companyId, company_id, userId, user_id and id', () => {
  const out = picker(
    { name: 'x', companyId: 'other-co', company_id: 'other-co', userId: 'victim', user_id: 'victim', id: 'other-row' },
    lists.FLOW_EDITABLE_FIELDS,
  );
  assert.deepEqual(out, { name: 'x' });
});

test('the picker strips other ownership and server-managed keys for every resource', () => {
  const body = {
    status: 'cancelled', flowId: 'other-flow', callId: 'c', googleCalendarEventId: 'g', createdAt: 'x',
    updatedAt: 'x', compiledSystemPrompt: 'x', isTemplate: true, contactName: 'Ann',
  };
  assert.deepEqual(picker(body, lists.APPOINTMENT_EDITABLE_FIELDS), { status: 'cancelled', contactName: 'Ann' });
  assert.deepEqual(picker({ isTemplate: true, compiledTools: [], name: 'n' }, lists.FLOW_EDITABLE_FIELDS), { name: 'n' });
});

test('the picker returns null when no editable field is present (caller answers 400)', () => {
  const allowed = lists.WEBHOOK_EDITABLE_FIELDS;
  assert.equal(picker({}, allowed), null);
  assert.equal(picker({ companyId: 'other-co', userId: 'victim', id: 'x' }, allowed), null);
  assert.equal(picker({ unknownField: 1 }, allowed), null);
  assert.equal(picker(undefined, allowed), null);
  assert.equal(picker(null, allowed), null);
  assert.equal(picker('a string', allowed), null);
  assert.equal(picker(['name'], allowed), null);
});

test('the picker ignores prototype keys and reads only own properties', () => {
  const body = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "name": "ok"}');
  const out = picker(body, lists.FLOW_EDITABLE_FIELDS);
  assert.deepEqual(out, { name: 'ok' });
  assert.equal({}.polluted, undefined);
});

test('the picker keeps an explicit null for a nullable editable field', () => {
  assert.deepEqual(picker({ notes: null }, lists.APPOINTMENT_EDITABLE_FIELDS), { notes: null });
});
