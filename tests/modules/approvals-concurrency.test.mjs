// Concurrency and state tests for ApprovalService revoke and resubmit, run against the real service
// with an in-memory fake store. No database, network or provider calls.
//
// The fake evaluates the drizzle condition objects that ApprovalService builds (eq, and, or, isNull,
// inArray, gt, sql templates), so the conditional UPDATEs run the same logic as the SQL. Each statement
// yields to the event loop before it runs, so parallel calls interleave. Row locks are held until the
// transaction commits or rolls back, and a rollback restores the undo log. This matches Postgres
// READ COMMITTED for single-row conditional updates. The partial unique index in
// migrations/DRAFT_approvals_one_pending.sql is emulated on insert and update.
//
// Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/modules/approvals-concurrency.test.mjs

// Test files must not write to stdout (the test runner's IPC breaks). Silence the console first.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SQL, Column, Param, StringChunk, getTableColumns } from 'drizzle-orm';

// approval-service.ts imports '../../services/audit-log' (opens the app DB pool). Swap it for a stub
// that records each event on globalThis, and resolve the extensionless relative imports as the other
// approval tests do.
globalThis.__auditEvents = [];
const AUDIT_STUB = 'export async function logAuditEvent(entry) { globalThis.__auditEvents.push(entry); }';
const HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let stubs = [];
export function initialize(data) { stubs = data.stubs; }
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.')) {
    const hit = stubs.find(([suffix]) => specifier.endsWith(suffix));
    if (hit) {
      return { url: 'data:text/javascript,' + encodeURIComponent(hit[1]), format: 'module', shortCircuit: true };
    }
    if (!/\\.[cm]?[jt]s$/.test(specifier)) {
      for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url, {
  data: { stubs: [['/services/audit-log', AUDIT_STUB]] },
});

const { ApprovalService } = await import('../../server/modules/approvals/approval-service.ts');
const { buildApprovalView } = await import('../../server/modules/approvals/approval-view.ts');
const { hashAction } = await import('../../server/modules/approvals/approval-signing.ts');
const { approvals, approvalRules } = await import('../../server/modules/approvals/schema.ts');

const COMPANY = 'co-a';
const MIGRATIONS = new URL('../../migrations/', import.meta.url);

// -- SQL evaluation ----------------------------------------------------------
// drizzle condition objects are rendered to a small text form, tokenized and parsed. Only the forms
// ApprovalService uses are supported. An unknown form throws, so a new query shape fails loudly.

function renderSql(node, params, out) {
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks) renderSql(chunk, params, out);
  } else if (node instanceof StringChunk) {
    out.push(` ${node.value.join('')} `);
  } else if (node instanceof Column) {
    out.push(` @${node.name} `);
  } else if (node instanceof Param) {
    params.push(node.value);
    out.push(` $${params.length - 1} `);
  } else if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' || node instanceof Date) {
    // A raw value inside a sql template is bound as a parameter, as drizzle does.
    params.push(node);
    out.push(` $${params.length - 1} `);
  } else if (Array.isArray(node)) {
    out.push(' ( ');
    node.forEach((item, i) => {
      if (i > 0) out.push(' , ');
      renderSql(item, params, out);
    });
    out.push(' ) ');
  } else {
    throw new Error(`unsupported SQL node: ${node?.constructor?.name ?? typeof node}`);
  }
  return out;
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '@') {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      toks.push({ t: 'col', v: m[1] });
      i += m[0].length;
      continue;
    }
    if (c === '$') {
      const m = /^\$(\d+)/.exec(src.slice(i));
      toks.push({ t: 'param', v: Number(m[1]) });
      i += m[0].length;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated string in SQL');
      toks.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (src.startsWith('::', i)) {
      const m = /^::[A-Za-z_]+/.exec(src.slice(i));
      i += m[0].length; // cast, ignored
      continue;
    }
    const op = ['->>', '||', '<>', '>=', '<=', '=', '>', '<'].find((o) => src.startsWith(o, i));
    if (op) {
      toks.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      toks.push({ t: c });
      i++;
      continue;
    }
    const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (w) {
      toks.push({ t: 'word', v: w[0].toLowerCase() });
      i += w[0].length;
      continue;
    }
    throw new Error(`unsupported SQL near: ${src.slice(i, i + 20)}`);
  }
  return toks;
}

function parse(toks, asValue) {
  let p = 0;
  const isWord = (v) => toks[p]?.t === 'word' && toks[p].v === v;
  const expect = (t) => {
    if (toks[p]?.t !== t) throw new Error(`SQL parse: expected ${t}`);
    p++;
  };

  function parsePrimary() {
    const k = toks[p];
    if (!k) throw new Error('SQL parse: unexpected end');
    if (k.t === 'col') { p++; return { k: 'col', name: k.v }; }
    if (k.t === 'param') { p++; return { k: 'param', i: k.v }; }
    if (k.t === 'str') { p++; return { k: 'lit', v: k.v }; }
    if (k.t === 'word' && k.v === 'jsonb_build_object') {
      p++;
      expect('(');
      const args = [parseValue()];
      while (toks[p]?.t === ',') { p++; args.push(parseValue()); }
      expect(')');
      return { k: 'obj', args };
    }
    if (k.t === '(') {
      p++;
      const inner = parseValue();
      expect(')');
      return inner;
    }
    throw new Error(`SQL parse: unexpected token ${k.t}`);
  }

  function parseValue() {
    let left = parsePrimary();
    while (toks[p]?.t === 'op' && (toks[p].v === '->>' || toks[p].v === '||')) {
      const op = toks[p].v;
      p++;
      left = { k: op, l: left, r: parsePrimary() };
    }
    return left;
  }

  function parsePredicate() {
    if (toks[p]?.t === '(') {
      p++;
      const inner = parseOr();
      expect(')');
      return inner;
    }
    const left = parseValue();
    const k = toks[p];
    if (k?.t === 'op' && ['=', '<>', '>', '<', '>=', '<='].includes(k.v)) {
      p++;
      return { k: 'cmp', op: k.v, l: left, r: parseValue() };
    }
    if (isWord('is')) {
      p++;
      let negate = false;
      if (isWord('not')) { p++; negate = true; }
      if (!isWord('null')) throw new Error('SQL parse: expected null');
      p++;
      return { k: negate ? 'notnull' : 'isnull', l: left };
    }
    if (isWord('in')) {
      p++;
      expect('(');
      const items = [parseValue()];
      while (toks[p]?.t === ',') { p++; items.push(parseValue()); }
      expect(')');
      return { k: 'in', l: left, items };
    }
    throw new Error('SQL parse: unsupported predicate');
  }

  function parseAnd() {
    let left = parsePredicate();
    while (isWord('and')) { p++; left = { k: 'and', l: left, r: parsePredicate() }; }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (isWord('or')) { p++; left = { k: 'or', l: left, r: parseAnd() }; }
    return left;
  }

  const tree = asValue ? parseValue() : parseOr();
  if (p !== toks.length) throw new Error('SQL parse: trailing tokens');
  return tree;
}

const norm = (v) => (v instanceof Date ? v.getTime() : v);

function evalNode(n, ctx) {
  switch (n.k) {
    case 'col': {
      const key = ctx.nameToKey.get(n.name);
      if (key === undefined) throw new Error(`unknown column ${n.name}`);
      return ctx.row[key] ?? null;
    }
    case 'param': return ctx.params[n.i] ?? null;
    case 'lit': return n.v;
    case '->>': {
      const obj = evalNode(n.l, ctx);
      const key = evalNode(n.r, ctx);
      if (obj === null || typeof obj !== 'object') return null;
      const v = obj[key];
      if (v === undefined || v === null) return null;
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    case '||': {
      const a = evalNode(n.l, ctx);
      const b = evalNode(n.r, ctx);
      return { ...(a ?? {}), ...(b ?? {}) };
    }
    case 'obj': {
      const out = {};
      for (let i = 0; i < n.args.length; i += 2) out[evalNode(n.args[i], ctx)] = evalNode(n.args[i + 1], ctx);
      return out;
    }
    case 'cmp': {
      const a = evalNode(n.l, ctx);
      const b = evalNode(n.r, ctx);
      if (a === null || b === null) return null;
      const x = norm(a);
      const y = norm(b);
      switch (n.op) {
        case '=': return x === y;
        case '<>': return x !== y;
        case '>': return x > y;
        case '<': return x < y;
        case '>=': return x >= y;
        case '<=': return x <= y;
        default: throw new Error(`unsupported operator ${n.op}`);
      }
    }
    case 'isnull': return evalNode(n.l, ctx) === null;
    case 'notnull': return evalNode(n.l, ctx) !== null;
    case 'in': {
      const a = evalNode(n.l, ctx);
      if (a === null) return false;
      return n.items.some((item) => {
        const b = evalNode(item, ctx);
        return b !== null && norm(b) === norm(a);
      });
    }
    case 'and': return evalNode(n.l, ctx) === true && evalNode(n.r, ctx) === true;
    case 'or': return evalNode(n.l, ctx) === true || evalNode(n.r, ctx) === true;
    default: throw new Error(`unsupported node ${n.k}`);
  }
}

function compile(node, asValue) {
  const params = [];
  const text = renderSql(node, params, []).join('');
  return { tree: parse(tokenize(text), asValue), params };
}

// -- fake store --------------------------------------------------------------

const pgError = (code, message) => Object.assign(new Error(message), { code });
const clone = (v) => structuredClone(v);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function createStore() {
  const tables = new Map([[approvals, []], [approvalRules, []]]);
  const keys = new Map();
  for (const table of tables.keys()) {
    keys.set(table, new Map(Object.entries(getTableColumns(table)).map(([key, col]) => [col.name, key])));
  }
  const store = {
    tables,
    keys,
    locks: new Map(),
    waiters: new Map(),
    txSeq: 0,
    failNextInsert: false,
    /** Test hook: returns a promise to hold an update before its condition is evaluated, or null. */
    holdWhen: null,
    rows: (table) => tables.get(table),
    predicate(table, cond) {
      if (!cond) return () => true;
      const { tree, params } = compile(cond, false);
      const nameToKey = keys.get(table);
      return (row) => evalNode(tree, { row, params, nameToKey }) === true;
    },
    evalSql(table, sqlNode, row) {
      const { tree, params } = compile(sqlNode, true);
      return evalNode(tree, { row, params, nameToKey: keys.get(table) });
    },
    project(table, fields, row) {
      if (!fields) return clone(row);
      const nameToKey = keys.get(table);
      const out = {};
      for (const [key, col] of Object.entries(fields)) out[key] = clone(row[nameToKey.get(col.name)]);
      return out;
    },
    /** The partial unique index from DRAFT_approvals_one_pending.sql, emulated. */
    assertUnique(table, row) {
      if (table !== approvals || row.status !== 'pending') return;
      const from = row.context?.resubmittedFrom;
      if (typeof from !== 'string') return;
      const clash = tables.get(approvals).find((other) => other !== row
        && other.status === 'pending'
        && other.companyId === row.companyId
        && other.context?.resubmittedFrom === from);
      if (clash) {
        throw pgError(
          '23505',
          'duplicate key value violates unique constraint "approvals_one_pending_per_source_uidx"',
        );
      }
    },
    async lockRow(tx, rowKey) {
      for (;;) {
        const owner = store.locks.get(rowKey);
        if (owner === undefined || owner === tx.id) {
          store.locks.set(rowKey, tx.id);
          tx.held.add(rowKey);
          return;
        }
        await new Promise((resolve) => {
          const list = store.waiters.get(rowKey) ?? [];
          list.push(resolve);
          store.waiters.set(rowKey, list);
        });
      }
    },
    releaseLocks(tx) {
      for (const rowKey of tx.held) {
        store.locks.delete(rowKey);
        const list = store.waiters.get(rowKey) ?? [];
        store.waiters.delete(rowKey);
        for (const resolve of list) resolve();
      }
      tx.held.clear();
    },
  };
  return store;
}

const rowKeyOf = (table, row) => `${table === approvals ? 'approvals' : 'rules'}:${row.id}`;

class SelectQuery {
  constructor(store, fields) {
    this.store = store;
    this.fields = fields;
    this.table = null;
    this.cond = undefined;
    this.max = Infinity;
  }
  from(table) { this.table = table; return this; }
  where(cond) { this.cond = cond; return this; }
  orderBy() { return this; }
  limit(n) { this.max = n; return this; }
  then(onOk, onErr) { return this.exec().then(onOk, onErr); }
  async exec() {
    await tick();
    const pred = this.store.predicate(this.table, this.cond);
    return this.store.rows(this.table)
      .filter((row) => pred(row))
      .slice(0, this.max)
      .map((row) => this.store.project(this.table, this.fields, row));
  }
}

class UpdateQuery {
  constructor(store, tx, table) {
    this.store = store;
    this.tx = tx;
    this.table = table;
    this.values = {};
    this.cond = undefined;
    this.fields = undefined;
  }
  set(values) { this.values = values; return this; }
  where(cond) { this.cond = cond; return this; }
  returning(fields) { this.fields = fields; return this; }
  then(onOk, onErr) { return this.exec().then(onOk, onErr); }
  async exec() {
    const { store, tx, table } = this;
    await tick();
    const hold = store.holdWhen?.(this.values);
    if (hold) await hold;
    const pred = store.predicate(table, this.cond);
    // A row that another open transaction has written is locked. Its visible state may change when that
    // transaction ends, so it is always a candidate and the condition is re-checked after the lock wait.
    const candidates = store.rows(table).filter((row) => {
      const owner = store.locks.get(rowKeyOf(table, row));
      return pred(row) || (owner !== undefined && owner !== tx.id);
    });
    const out = [];
    for (const row of candidates) {
      await store.lockRow(tx, rowKeyOf(table, row));
      // Re-check the condition on the locked version, as READ COMMITTED does after a row lock wait.
      if (!pred(row)) continue;
      const before = clone(row);
      const next = {};
      for (const [key, value] of Object.entries(this.values)) {
        if (value === undefined) continue;
        next[key] = value instanceof SQL ? store.evalSql(table, value, row) : value;
      }
      tx.undo.push({ kind: 'update', table, id: row.id, before });
      Object.assign(row, next);
      store.assertUnique(table, row);
      out.push(store.project(table, this.fields, row));
    }
    return out;
  }
}

class InsertQuery {
  constructor(store, tx, table) {
    this.store = store;
    this.tx = tx;
    this.table = table;
    this.vals = {};
    this.fields = undefined;
  }
  values(vals) { this.vals = vals; return this; }
  returning(fields) { this.fields = fields; return this; }
  then(onOk, onErr) { return this.exec().then(onOk, onErr); }
  async exec() {
    const { store, tx, table } = this;
    await tick();
    if (store.failNextInsert) {
      store.failNextInsert = false;
      throw new Error('simulated insert failure');
    }
    const now = new Date();
    const row = {
      id: randomUUID(),
      requestedBy: null,
      agentId: null,
      urgency: 'normal',
      params: {},
      context: {},
      status: 'pending',
      decision: null,
      policyId: null,
      decidedBy: null,
      decisionReason: null,
      decidedAt: null,
      executedAt: null,
      createdAt: now,
      updatedAt: now,
      ...Object.fromEntries(Object.entries(this.vals).filter(([, v]) => v !== undefined)),
    };
    store.assertUnique(table, row);
    store.rows(table).push(row);
    tx.undo.push({ kind: 'insert', table, id: row.id });
    return [store.project(table, this.fields, row)];
  }
}

function createTenant(store) {
  return {
    async run(companyId, fn) {
      if (!companyId) throw new Error('companyId required');
      const tx = { id: ++store.txSeq, undo: [], held: new Set() };
      const db = {
        select: (fields) => new SelectQuery(store, fields),
        update: (table) => new UpdateQuery(store, tx, table),
        insert: (table) => new InsertQuery(store, tx, table),
      };
      try {
        const result = await fn(db);
        store.releaseLocks(tx);
        return result;
      } catch (error) {
        for (const undo of tx.undo.reverse()) {
          const rows = store.rows(undo.table);
          if (undo.kind === 'insert') {
            const index = rows.findIndex((row) => row.id === undo.id);
            if (index >= 0) rows.splice(index, 1);
          } else {
            const row = rows.find((r) => r.id === undo.id);
            if (row) {
              for (const key of Object.keys(row)) delete row[key];
              Object.assign(row, undo.before);
            }
          }
        }
        store.releaseLocks(tx);
        throw error;
      }
    },
  };
}

function setup() {
  const store = createStore();
  const tenant = createTenant(store);
  const service = new ApprovalService({ tenant });
  globalThis.__auditEvents.length = 0;
  return { store, tenant, service };
}

/** Inserts an approval row directly, the way a gated action would have left it. */
function seedApproval(store, overrides = {}) {
  const action = overrides.action ?? 'send_refund';
  const params = overrides.params ?? { amount: 40, to: 'cust@example.com' };
  const createdAt = new Date(Date.now() - 120_000);
  const row = {
    id: overrides.id ?? randomUUID(),
    companyId: overrides.companyId ?? COMPANY,
    requestedBy: 'agent-user-7',
    agentId: 'agent-7',
    action,
    urgency: 'normal',
    params,
    context: { paramsSha256: hashAction(action, params), ...(overrides.context ?? {}) },
    status: overrides.status ?? 'pending',
    decision: 'route_to_human',
    policyId: null,
    decidedBy: overrides.decidedBy ?? null,
    decisionReason: null,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 3_600_000),
    decidedAt: overrides.decidedAt ?? null,
    executedAt: overrides.executedAt ?? null,
    createdAt,
    updatedAt: createdAt,
  };
  store.rows(approvals).push(row);
  return row.id;
}

const childrenOf = (store, sourceId) =>
  store.rows(approvals).filter((row) => row.context?.resubmittedFrom === sourceId);

const rowOf = (store, id) => store.rows(approvals).find((row) => row.id === id);

const auditFor = (id, action) =>
  globalThis.__auditEvents.filter((e) => e.resourceId === id && (action === undefined || e.action === action));

// -- resubmit: at most one pending approval per source -----------------------

test('two parallel resubmits of one rejected source: exactly one pending child', async () => {
  const { store, service } = setup();
  const source = seedApproval(store, { status: 'rejected', decidedBy: 'dashboard:boss-2', decidedAt: new Date() });

  const results = await Promise.all([
    service.resubmitApproval(COMPANY, source, { amount: 25 }, 'user-a'),
    service.resubmitApproval(COMPANY, source, { amount: 30 }, 'user-b'),
  ]);

  const won = results.filter((r) => r.kind === 'ok');
  const lost = results.filter((r) => r.kind === 'refused');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.match(lost[0].error, /already been resubmitted/);

  const children = childrenOf(store, source);
  assert.equal(children.length, 1);
  assert.equal(children[0].status, 'pending');
  assert.equal(children[0].id, won[0].approval.id);
  assert.equal(rowOf(store, source).context.resubmittedTo, children[0].id);
});

test('five parallel resubmits of one expired source: exactly one child, four refused', async () => {
  const { store, service } = setup();
  const source = seedApproval(store, { status: 'expired', expiresAt: new Date(Date.now() - 60_000) });

  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => service.resubmitApproval(COMPANY, source, { amount: 10 + n }, `user-${n}`)),
  );

  assert.equal(results.filter((r) => r.kind === 'ok').length, 1);
  const refused = results.filter((r) => r.kind === 'refused');
  assert.equal(refused.length, 4);
  for (const r of refused) assert.match(r.error, /already been resubmitted/);
  assert.equal(childrenOf(store, source).length, 1);
});

test('a failed insert rolls back the claim, so a parallel resubmit can still succeed', async () => {
  const { store, service } = setup();
  const source = seedApproval(store, { status: 'rejected', decidedBy: 'dashboard:boss-2', decidedAt: new Date() });
  store.failNextInsert = true;

  const results = await Promise.allSettled([
    service.resubmitApproval(COMPANY, source, { amount: 25 }, 'user-a'),
    service.resubmitApproval(COMPANY, source, { amount: 30 }, 'user-b'),
  ]);

  const failed = results.filter((r) => r.status === 'rejected');
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason.message, /simulated insert failure/);
  assert.equal(succeeded.length, 1);
  assert.equal(succeeded[0].value.kind, 'ok');

  const children = childrenOf(store, source);
  assert.equal(children.length, 1);
  assert.equal(rowOf(store, source).context.resubmittedTo, children[0].id);
});

test('a pending child cannot be resubmitted, and a second resubmit of the source creates nothing', async () => {
  const { store, service } = setup();
  const source = seedApproval(store, { status: 'expired', expiresAt: new Date(Date.now() - 60_000) });

  const first = await service.resubmitApproval(COMPANY, source, { amount: 10 }, 'user-a');
  assert.equal(first.kind, 'ok');
  const child = first.approval.id;

  const again = await service.resubmitApproval(COMPANY, source, { amount: 11 }, 'user-a');
  assert.equal(again.kind, 'refused');
  assert.match(again.error, /already been resubmitted/);

  const onChild = await service.resubmitApproval(COMPANY, child, { amount: 12 }, 'user-a');
  assert.equal(onChild.kind, 'refused');
  assert.equal(onChild.status, 'pending');
  assert.equal(childrenOf(store, source).length, 1);
});

test('database backstop: the partial unique index refuses a second pending row for one source', async () => {
  const { store, tenant, service } = setup();
  const source = seedApproval(store, { status: 'rejected', decidedBy: 'dashboard:boss-2', decidedAt: new Date() });
  const first = await service.resubmitApproval(COMPANY, source, { amount: 25 }, 'user-a');
  assert.equal(first.kind, 'ok');

  const row = (status) => ({
    companyId: COMPANY,
    action: 'send_refund',
    params: {},
    context: { resubmittedFrom: source },
    status,
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  await assert.rejects(
    tenant.run(COMPANY, (db) => db.insert(approvals).values(row('pending'))),
    (error) => error.code === '23505',
  );
  // The index covers pending rows only, so a terminal row for the same source is allowed.
  await tenant.run(COMPANY, (db) => db.insert(approvals).values(row('rejected')));
  assert.equal(childrenOf(store, source).length, 2);
});

// -- revoke: concurrency -----------------------------------------------------

test('two parallel revokes of one pending approval: one succeeds, the other sees revoked', async () => {
  const { store, service } = setup();
  const id = seedApproval(store);

  const results = await Promise.all([
    service.revokeApproval(COMPANY, id, 'dashboard:boss-1', 'wrong amount'),
    service.revokeApproval(COMPANY, id, 'dashboard:boss-2', 'duplicate'),
  ]);

  const won = results.filter((r) => r.kind === 'ok');
  const lost = results.filter((r) => r.kind === 'refused');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].status, 'revoked');
  assert.match(lost[0].error, /Only pending or approved/);

  const row = rowOf(store, id);
  assert.equal(row.status, 'revoked');
  assert.equal(row.decidedBy, won[0].approval.decidedBy);
  assert.equal(auditFor(id, 'approval.revoked').length, 1);
});

test('revoke racing approve on one pending approval: revoke wins either way and the final state is revoked', async () => {
  const { store, service } = setup();
  const id = seedApproval(store);

  const [decided, revoked] = await Promise.all([
    service.decideApproval(COMPANY, id, 'approved', 'dashboard:boss-2'),
    service.revokeApproval(COMPANY, id, 'dashboard:boss-1'),
  ]);

  assert.equal(revoked.kind, 'ok');
  // If the approve landed first, it is an approved row, which revoke may still withdraw. If revoke
  // landed first, the approve finds no pending row and returns null. Either way the end state is revoked.
  assert.ok(decided === null || decided.status === 'approved');
  assert.equal(rowOf(store, id).status, 'revoked');
});

test('revoke racing markExecuted on one approved approval: exactly one wins, never both', async () => {
  const { store, service } = setup();
  const id = seedApproval(store, { status: 'approved', decidedBy: 'dashboard:boss-2', decidedAt: new Date() });

  const [executed, revoked] = await Promise.all([
    service.markExecuted(COMPANY, id, 'agent-7'),
    service.revokeApproval(COMPANY, id, 'dashboard:boss-1'),
  ]);

  const didExecute = executed !== null;
  const didRevoke = revoked.kind === 'ok';
  assert.ok(didExecute !== didRevoke, 'exactly one of execute or revoke must win');
  const row = rowOf(store, id);
  if (didExecute) {
    assert.equal(row.status, 'approved');
    assert.ok(row.executedAt instanceof Date);
    assert.equal(revoked.executed, true);
  } else {
    assert.equal(row.status, 'revoked');
    assert.equal(row.executedAt, null);
    assert.equal(executed, null);
  }
});

test('revoke that read the row before an execute committed: the re-check on the locked row refuses it', async () => {
  const { store, service } = setup();
  const id = seedApproval(store, { status: 'approved', decidedBy: 'dashboard:boss-2', decidedAt: new Date() });
  let release;
  // Park the revoke's UPDATE after its read. Its read still sees an approved, unexecuted row.
  store.holdWhen = (values) => (values.status === 'revoked'
    ? new Promise((resolve) => { release = resolve; })
    : null);

  const revoking = service.revokeApproval(COMPANY, id, 'dashboard:boss-1');
  while (release === undefined) await tick();
  const executed = await service.markExecuted(COMPANY, id, 'agent-7');
  store.holdWhen = null;
  release();
  const revoked = await revoking;

  assert.notEqual(executed, null);
  assert.equal(revoked.kind, 'refused');
  assert.equal(revoked.executed, true);
  const row = rowOf(store, id);
  assert.equal(row.status, 'approved');
  assert.ok(row.executedAt instanceof Date);
});

// -- revoked state is explicit -----------------------------------------------

test('revoked is a terminal state: no decision, no execution, no resubmit, and waiters are told', async () => {
  const { store, service } = setup();
  const id = seedApproval(store);
  const waiting = service.waitForDecision(COMPANY, id, 60_000);

  const revoked = await service.revokeApproval(COMPANY, id, 'dashboard:boss-1', 'withdrawn');
  assert.equal(revoked.kind, 'ok');
  assert.equal(revoked.approval.status, 'revoked');
  assert.equal(await waiting, 'revoked');

  assert.equal(await service.decideApproval(COMPANY, id, 'approved', 'dashboard:boss-2'), null);
  assert.equal(await service.markExecuted(COMPANY, id, 'agent-7'), null);

  const resubmit = await service.resubmitApproval(COMPANY, id, { amount: 1 }, 'user-a');
  assert.equal(resubmit.kind, 'refused');
  assert.equal(resubmit.status, 'revoked');
  assert.equal(childrenOf(store, id).length, 0);

  const current = await service.getApproval(COMPANY, id);
  assert.equal(current.status, 'revoked');
  assert.equal(rowOf(store, id).decisionReason, 'withdrawn');
});

test('listApprovals filters revoked rows by status', async () => {
  const { store, service } = setup();
  const revokedId = seedApproval(store, { status: 'revoked', decidedBy: 'dashboard:boss-1', decidedAt: new Date() });
  seedApproval(store);

  const listed = await service.listApprovals(COMPANY, { status: 'revoked' });
  assert.deepEqual(listed.map((a) => a.id), [revokedId]);
});

test('approval view surfaces the status, including revoked; an unknown status reads as unknown', () => {
  const base = {
    id: 'appr-1',
    companyId: COMPANY,
    requestedBy: 'agent-user-7',
    agentId: 'agent-7',
    action: 'send_refund',
    params: { amount: 40 },
    context: {},
    decidedBy: 'dashboard:boss-1',
    decidedAt: new Date(),
    executedAt: null,
    paramsSha256: null,
    createdAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60_000),
    decision: 'route_to_human',
    policyId: null,
    decisionReason: null,
    urgency: 'normal',
  };
  const now = new Date();
  assert.equal(buildApprovalView({ ...base, status: 'revoked' }, { now }).status, 'revoked');
  assert.equal(buildApprovalView({ ...base, status: 'pending' }, { now }).status, 'pending');
  assert.equal(buildApprovalView({ ...base, status: 'mystery' }, { now }).status, 'unknown');
});

// -- draft migration ---------------------------------------------------------

test('DRAFT_approvals_one_pending.sql carries the guard, the revoked check and the partial unique index', () => {
  const sql = readFileSync(new URL('DRAFT_approvals_one_pending.sql', MIGRATIONS), 'utf8');
  assert.match(sql, /DRAFT - NOT APPLIED/);
  assert.match(sql, /RAISE EXCEPTION/);
  assert.match(sql, /'revoked'\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_per_source_uidx/);
  assert.match(sql, /WHERE status = 'pending'/);

  const journal = readFileSync(new URL('meta/_journal.json', MIGRATIONS), 'utf8');
  assert.equal(journal.includes('one_pending'), false);
});
