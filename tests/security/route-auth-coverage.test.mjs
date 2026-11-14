/**
 * Route auth coverage (issue #126 follow-up).
 *
 * Static scan, no DB or app import needed:
 *   1. Start at server/index.ts and follow relative imports (static, export-from, dynamic) to get the
 *      set of server files the app can load. Only those files are scanned.
 *   2. Find every route definition (receiver.get/post/put/patch/delete/all with a path or path constant).
 *   3. A route counts as covered when one of these is true:
 *        a. its own statement (route line plus inline handler) names an auth or permission guard;
 *        b. the same router got an auth guard via .use() earlier in the same file;
 *        c. the file is mounted behind an auth guard: an auth .use() names the file's router or
 *           middleware import, or passes the router to a register function that lives in the file.
 *   4. Any route not covered must be listed in tests/security/route-auth-allowlist.json (owner-approved).
 *      A stale allowlist entry (route no longer exists) also fails, so the list stays honest.
 *
 * Limits: this checks that a guard is named, not that the guard is correct. Routes that are only
 * protected by a guard in a parent file that is not reachable by these rules show up as unlisted,
 * which is the intended failure mode. WebSocket upgrade handlers are not routes and are not scanned.
 *
 * Run: node --test --experimental-transform-types tests/security/route-auth-coverage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWLIST_PATH = path.join(ROOT, 'tests/security/route-auth-allowlist.json');

const AUTH_RE = new RegExp(
  '\\b(' +
    [
      'authenticate\\w*',
      'requireAuth\\w*',
      'requireAdmin\\w*',
      'requireSuperAdmin',
      'requireRole',
      'requireManager',
      'requireApprover',
      'requireCompanyScope',
      'requireStaff\\w*',
      'staffOnly',
      'checkAdmin\\w*',
      'checkSuperAdmin',
      'requirePermission',
      'requireAdminPermission',
      'require\\w*Signature',
      'validate\\w*Webhook',
      'verify\\w*Webhook',
      'verifyPlivo',
      'verifyTwilio\\w*',
      'hybridGate\\w*',
      'timingSafeEqual',
      // own verification inside the handler (provider signatures, shared-secret compares)
      'constructEvent',
      'createHmac',
      'x-hub-signature\\w*',
      'stripe-signature',
      'x-razorpay-signature',
      'x-paystack-signature',
      'x-signature',
      'WEBHOOK_TOKEN',
    ].join('|') +
    ')\\b',
);
const ROUTER_RECEIVER_RE = /^(app|r|api|router|\w*[Rr]outer)$/;
const ROUTE_CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*/g;

// ---------- lexing helpers ----------

function skipString(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === q) return i + 1;
    i++;
  }
  return i;
}

/** Given index of '(' return index just after its matching ')'. */
function callEnd(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

/** Remove // and block comments so doc examples are not counted as routes. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Return every route definition and auth .use() call in one source file. */
export function scanSource(input) {
  const src = stripComments(input);
  const routes = [];
  const uses = [];
  ROUTE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_CALL_RE.exec(src))) {
    const [, receiver, method] = m;
    if (!ROUTER_RECEIVER_RE.test(receiver)) continue;
    const openIdx = src.indexOf('(', m.index + m[0].length - 1);
    const end = callEnd(src, openIdx);
    const args = src.slice(openIdx + 1, end - 1);
    if (method === 'use') {
      if (AUTH_RE.test(args)) uses.push({ receiver, index: m.index, args });
      continue;
    }
    // Route path: string literal starting with '/', or an identifier constant followed by a comma.
    const lit = /^\s*(['"`])([^'"`]*)\1/.exec(args);
    const ident = /^\s*([A-Za-z_$][\w$]*)\s*,/.exec(args);
    let routePath;
    if (lit && lit[2].startsWith('/')) routePath = lit[2];
    else if (ident) routePath = `<${ident[1]}>`;
    else continue;
    routes.push({
      receiver,
      method: method.toUpperCase(),
      path: routePath,
      index: m.index,
      inlineAuth: AUTH_RE.test(args),
    });
  }
  return { routes, uses };
}

// ---------- module graph ----------

function resolveSpec(files, fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const stripped = base.replace(/\.(m?js|ts|tsx)$/, '');
  const candidates = [
    base,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.mjs`,
    `${stripped}.js`,
    `${stripped}/index.ts`,
    `${stripped}/index.js`,
  ];
  return candidates.find((c) => files.has(c)) ?? null;
}

function importsOf(src) {
  const specs = new Set();
  for (const re of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    let m;
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  return [...specs];
}

/** Map of local name -> { spec, imported } for named and default imports. */
function importNames(src) {
  const map = new Map();
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const clause = m[1];
    const spec = m[2];
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      for (const part of named[1].split(',')) {
        const p = part.trim().replace(/^type\s+/, '');
        if (!p) continue;
        const [imported, local] = p.split(/\s+as\s+/);
        map.set((local ?? imported).trim(), { spec, imported: imported.trim() });
      }
    }
    const def = /^\s*([A-Za-z_$][\w$]*)\s*(,|$)/.exec(clause);
    if (def) map.set(def[1], { spec, imported: 'default' });
  }
  return map;
}

/** Follow export-from chains until the file that defines the name. */
function definingFile(files, rel, name, depth = 0) {
  if (depth > 8) return null;
  const src = files.get(rel);
  if (!src) return null;
  const defines = new RegExp(
    `(?:function|class|const|let|var)\\s+${name}\\b`,
  ).test(src);
  if (defines) return rel;
  const re = /export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(',')) {
      const [imported, exported] = part.trim().split(/\s+as\s+/);
      if ((exported ?? imported).trim() !== name) continue;
      const target = resolveSpec(files, rel, m[2]);
      if (target) {
        const hit = definingFile(files, target, imported.trim(), depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function resolveImported(files, rel, localName) {
  const entry = importNames(files.get(rel) ?? '').get(localName);
  if (!entry) return null;
  const target = resolveSpec(files, rel, entry.spec);
  if (!target) return null;
  if (entry.imported === 'default') return target;
  return definingFile(files, target, entry.imported) ?? target;
}

/** Files reachable from server/index.ts through relative imports. */
export function reachableFiles(readFile, listFiles, entry = 'server/index.ts') {
  const files = new Map();
  for (const rel of listFiles()) files.set(rel, stripComments(readFile(rel)));
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || !files.has(rel)) continue;
    seen.add(rel);
    for (const spec of importsOf(files.get(rel))) {
      const target = resolveSpec(files, rel, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  const reachable = new Map();
  for (const rel of seen) reachable.set(rel, files.get(rel));
  return reachable;
}

// ---------- coverage analysis ----------

/**
 * files: Map<relPath, source> (the reachable set). Returns every route with its coverage reason.
 */
export function analyze(files) {
  const mountCovered = new Map(); // rel -> reason
  const results = [];

  for (const [rel, src] of files) {
    const { routes, uses } = scanSource(src);

    // (c) files named by an auth .use() call in this file (router or middleware imports).
    for (const use of uses) {
      for (const ident of new Set(use.args.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
        let target = resolveImported(files, rel, ident);
        // a local router built by a factory: const router = createXRouter(...)
        const factory = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*(?:await\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`).exec(src);
        if (!target && factory) target = resolveImported(files, rel, factory[1]) ?? definingFile(files, rel, factory[1]);
        if (target && !mountCovered.has(target)) mountCovered.set(target, `mounted behind auth in ${rel}`);
      }
      // register functions called with the same router after the auth .use()
      const callRe = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\(\\s*${use.receiver}\\s*\\)`, 'g');
      let c;
      while ((c = callRe.exec(src))) {
        if (c.index <= use.index) continue;
        const target = resolveImported(files, rel, c[1]) ?? (files.has(rel) && definingFile(files, rel, c[1]));
        if (target && !mountCovered.has(target)) mountCovered.set(target, `registered after auth on ${use.receiver} in ${rel}`);
      }
    }

    for (const route of routes) {
      let reason = null;
      if (route.inlineAuth) reason = 'inline guard';
      else if (uses.some((u) => u.receiver === route.receiver && u.index < route.index)) reason = 'same-file guard';
      results.push({ file: rel, method: route.method, path: route.path, reason, _route: route });
    }
  }

  for (const r of results) {
    if (!r.reason && mountCovered.has(r.file)) r.reason = mountCovered.get(r.file);
  }
  return results.map(({ _route, ...rest }) => rest);
}

export function keyOf(r) {
  return `${r.file}|${r.method}|${r.path}`;
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return [];
  const data = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  return Array.isArray(data.entries) ? data.entries : [];
}

// ---------- tests ----------

test('scanner flags a deliberately unlisted route and accepts guarded ones', () => {
  const fixture = `
import { Router } from 'express';
import { requireAuth } from './middleware/auth';
const router = Router();
router.get('/open-data', (req, res) => res.json({ secret: 1 }));
router.get('/guarded', requireAuth, (req, res) => res.json({}));
router.post('/gated', (req, res) => res.json({}));
router.use(requireAuth);
router.delete('/after-use', (req, res) => res.json({}));
app.get('setting-name');
`;
  const results = analyze(new Map([['server/fixture.ts', fixture]]));
  const byPath = Object.fromEntries(results.map((r) => [r.path, r.reason]));
  assert.equal(byPath['/open-data'], null, 'unguarded route must be flagged');
  assert.equal(byPath['/gated'], null, 'unguarded route must be flagged');
  assert.equal(byPath['/guarded'], 'inline guard');
  assert.equal(byPath['/after-use'], 'same-file guard');
  assert.equal(results.length, 4, 'app.get("setting-name") is not a route');
});

test('every reachable server route is guarded or on the owner-approved allowlist', (t) => {
  const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const listFiles = () => {
    const out = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, ent.name);
        if (ent.isDirectory()) walk(rel);
        else if (/\.(ts|tsx|mjs|js)$/.test(ent.name)) out.push(rel);
      }
    };
    walk('server');
    return out;
  };

  const files = reachableFiles(readFile, listFiles);
  const routes = analyze(files);
  const allowed = new Set(loadAllowlist().map((e) => `${e.file}|${e.method}|${e.path}`));

  const covered = routes.filter((r) => r.reason);
  const unlisted = routes.filter((r) => !r.reason && !allowed.has(keyOf(r)));
  const flaggedKeys = new Set(routes.filter((r) => !r.reason).map(keyOf));
  const stale = [...allowed].filter((k) => !routes.some((r) => keyOf(r) === k));
  const allowedButGuarded = [...allowed].filter((k) => routes.some((r) => keyOf(r) === k && r.reason));

  t.diagnostic(`reachable files: ${files.size}`);
  t.diagnostic(`routes counted: ${routes.length}, covered: ${covered.length}, on allowlist: ${[...flaggedKeys].filter((k) => allowed.has(k)).length}`);

  assert.ok(routes.length >= 300, `expected at least 300 routes, found ${routes.length}; scanner may be broken`);
  assert.deepEqual(
    unlisted.map((r) => `${r.method} ${r.path}  (${r.file})`),
    [],
    'routes with no auth or permission guard and not on tests/security/route-auth-allowlist.json',
  );
  assert.deepEqual(stale, [], 'allowlist entries that match no reachable route; remove them');
  assert.deepEqual(allowedButGuarded, [], 'allowlist entries that are already guarded; remove them');
});
