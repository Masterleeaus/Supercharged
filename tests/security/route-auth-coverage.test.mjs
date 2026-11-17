/**
 * Route auth coverage (issue #126 follow-up).
 *
 * Static scan, no DB or app import needed:
 *   1. Start at server/index.ts and follow relative imports (static, export-from, dynamic) to get the
 *      set of server files the app can load. Only those files are scanned.
 *   2. Find every route definition: receiver.get/post/put/patch/delete/all call with two or more
 *      arguments (path, then handler). Paths may be string literals, identifier constants or template
 *      literals. Template and other expression paths are counted too, named <template ...> or
 *      <expr ...> in the path column, so they show up in the report instead of being dropped.
 *   3. A route counts as covered when one of these is true:
 *        a. a guard is passed as a middleware argument of the route call (not the handler), or the
 *           handler calls a guard in its preamble, before any business logic (await, return, res.,
 *           req.body, db, storage, fetch);
 *        b. the same router got an auth guard via .use() earlier in the same file;
 *        c. the file is mounted behind an auth guard: an auth .use() names the file's router or
 *           middleware import, or passes the router to a register function that lives in the file.
 *   4. Any route not covered must be listed in tests/security/route-auth-allowlist.json (owner-approved).
 *      A stale allowlist entry (route no longer exists) also fails, so the list stays honest.
 *
 * Lexing: maskSource() makes one pass over each file. Comments are blanked. String, template and
 * regex contents are blanked for guard matching, so text such as response messages or doc comments
 * can not hide code or count as a guard. Route paths and header names are read from the unmasked
 * text. Each assertion below is its own test, so every check runs and reports.
 *
 * Limits: this checks that a guard is named, not that the guard is correct. Routes that are only
 * protected by a guard in a parent file that is not reachable by these rules show up as unlisted,
 * which is the intended failure mode. WebSocket upgrade handlers are not routes and are not scanned.
 *
 * Run: node --test tests/security/route-auth-coverage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWLIST_PATH = path.join(ROOT, 'tests/security/route-auth-allowlist.json');

// Guard identifiers. Matched against code with strings and comments masked, so response text and
// comments never count. The bare past-tense word 'authenticated' is excluded.
const AUTH_RE = new RegExp(
  '\\b(' +
    [
      'authenticate(?!d\\b)\\w*',
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
      'verifyPlivo\\w*',
      'verifyTwilio\\w*',
      'hybridGate\\w*',
      'timingSafeEqual',
      'constructEvent',
      'createHmac',
      'WEBHOOK_TOKEN',
    ].join('|') +
    ')\\b',
);
// Provider signature headers. Checked against unmasked text, because the header name is a string.
const HEADER_RE = /['"`](?:x-hub-signature|stripe-signature|x-razorpay-signature|x-paystack-signature|x-signature|x-twilio-signature)(?:-\w+)?['"`]/i;
const ROUTER_RECEIVER_RE = /^(app|r|api|router|\w*[Rr]outer)$/;
const ROUTE_CALL_SRC = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all|use)\s*(?:<[^()]*?>)?\s*\(/.source;
// Mount-level patterns (see analyze, step c2). Matched against masked code, so strings and comments never count.
const LOCAL_ROUTER_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:express\.)?Router\s*\(/g;
// A local arrow helper that forwards its handler list into .use(), e.g. const mountAt = (p, handlers) => { app.use(p, ...handlers) }
const MOUNT_HELPER_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*(?::[^=;{]*)?=>\s*\{/g;
// A local array of handlers: const guards = [authenticate, router]
const HANDLER_ARRAY_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*\[/g;
// A dynamic import bound to a name: const pluginRoutes = await import('./plugin-routes'). Read from text (specs are strings).
const NS_IMPORT_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)/g;
const FUNC_RE = /=>|\bfunction\b/;
// Business work: reading the request body or query, touching data, or calling out. A guard must appear
// before the first line that does one of these. Config lookups and error responses are not business work.
const BUSINESS_RE = /\breq\.(?:body|query)\b|\bdb\b|\bstorage\b|\bpool\b|\bfetch\(/;

// ---------- lexing ----------

/**
 * One pass over a source file. Returns two strings of the same length as the input:
 *  - code: comments blanked; string, template and regex contents blanked (quotes and `${` `}` kept),
 *    so identifiers and brackets are exact.
 *  - text: comments blanked; string and template contents kept; regex contents blanked.
 */
export function maskSource(src) {
  const n = src.length;
  const code = new Array(n);
  const text = new Array(n);
  const nl = (k) => src[k] === '\n';
  const blankBoth = (k) => {
    code[k] = nl(k) ? '\n' : ' ';
    text[k] = code[k];
  };
  const blankCodeOnly = (k) => {
    code[k] = nl(k) ? '\n' : ' ';
    text[k] = src[k];
  };
  const keepBoth = (k) => {
    code[k] = src[k];
    text[k] = src[k];
  };

  let mode = 'code'; // code | str | tpl | re
  let quote = '';
  let inClass = false;
  let braces = 0;
  const exprBraces = []; // brace depth at each open ${ inside a template
  let prev = ''; // 'a' after a word or closing bracket, otherwise the last char; decides regex vs divide
  let i = 0;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (mode === 'code') {
      if (c === '/' && d === '/') {
        while (i < n && src[i] !== '\n') blankBoth(i++);
        continue;
      }
      if (c === '/' && d === '*') {
        blankBoth(i++);
        blankBoth(i++);
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blankBoth(i++);
        if (i < n) {
          blankBoth(i++);
          blankBoth(i++);
        }
        continue;
      }
      if (c === '"' || c === "'") {
        mode = 'str';
        quote = c;
        keepBoth(i++);
        prev = 'a';
        continue;
      }
      if (c === '`') {
        mode = 'tpl';
        keepBoth(i++);
        continue;
      }
      if (c === '/' && !/[\w$)\]]/.test(prev)) {
        mode = 're';
        inClass = false;
        blankBoth(i++);
        continue;
      }
      if (c === '{') braces++;
      else if (c === '}') {
        if (exprBraces.length && exprBraces[exprBraces.length - 1] === braces) {
          exprBraces.pop();
          mode = 'tpl';
          keepBoth(i++);
          continue;
        }
        braces--;
      }
      keepBoth(i);
      if (!/\s/.test(c)) prev = /[\w$)\]]/.test(c) ? 'a' : c;
      i++;
      continue;
    }

    if (mode === 'str') {
      if (c === '\\') {
        blankCodeOnly(i);
        if (i + 1 < n) blankCodeOnly(i + 1);
        i += 2;
        continue;
      }
      if (c === quote) {
        keepBoth(i);
        mode = 'code';
      } else if (c === '\n') {
        // unterminated string: recover at the line end
        keepBoth(i);
        mode = 'code';
      } else {
        blankCodeOnly(i);
      }
      i++;
      continue;
    }

    if (mode === 'tpl') {
      if (c === '\\') {
        blankCodeOnly(i);
        if (i + 1 < n) blankCodeOnly(i + 1);
        i += 2;
        continue;
      }
      if (c === '`') {
        keepBoth(i);
        mode = 'code';
        prev = 'a';
        i++;
        continue;
      }
      if (c === '$' && d === '{') {
        keepBoth(i);
        keepBoth(i + 1);
        exprBraces.push(braces);
        mode = 'code';
        prev = '{';
        i += 2;
        continue;
      }
      blankCodeOnly(i);
      i++;
      continue;
    }

    // regex literal
    if (c === '\\') {
      blankBoth(i);
      if (i + 1 < n) blankBoth(i + 1);
      i += 2;
      continue;
    }
    if (c === '\n') {
      keepBoth(i);
      mode = 'code';
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    if (c === '/' && !inClass) {
      blankBoth(i);
      mode = 'code';
      prev = 'a';
      i++;
      continue;
    }
    blankBoth(i);
    i++;
  }

  return { code: code.join(''), text: text.join('') };
}

/** Comments blanked, string contents kept. Used for import graph and path extraction. */
export function stripComments(src) {
  return maskSource(src).text;
}

/** Given index of '(' in masked code, return index just after its matching ')'. */
export function callEnd(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

/** Top-level argument spans of a call, given masked code and the '(' and ')' indices. */
function splitArgs(code, openIdx, closeIdx) {
  const segs = [];
  let depth = 0;
  let start = openIdx + 1;
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      segs.push({ start, end: i });
      start = i + 1;
    }
  }
  if (code.slice(start, closeIdx).trim() !== '') segs.push({ start, end: closeIdx });
  return segs;
}

/** Span of the function body that starts at idx (an '=>' or 'function' inside the segment). */
function functionBodySpan(seg, idx) {
  let from = idx;
  if (seg.startsWith('=>', idx)) {
    from = idx + 2;
    const rest = seg.slice(from).trimStart();
    from = seg.length - rest.length;
    if (rest[0] !== '{') {
      // expression body: ends at the next top-level comma or closing bracket
      let depth = 0;
      let j = from;
      for (; j < seg.length; j++) {
        const ch = seg[j];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') {
          if (depth === 0) break;
          depth--;
        } else if (ch === ',' && depth === 0) break;
      }
      return [from, j];
    }
  }
  const open = seg.indexOf('{', from);
  if (open < 0) return [from, seg.length];
  let depth = 0;
  for (let j = open; j < seg.length; j++) {
    if (seg[j] === '{') depth++;
    else if (seg[j] === '}') {
      depth--;
      if (depth === 0) return [open + 1, j];
    }
  }
  return [open + 1, seg.length];
}

/** Guard in a handler preamble: a guard line that comes before any business line. */
function preambleGuarded(codeBody, textBody, aliasRe) {
  const cl = codeBody.split('\n');
  const tl = textBody.split('\n');
  for (let k = 0; k < cl.length; k++) {
    if (isGuardText(cl[k], aliasRe) || HEADER_RE.test(tl[k] ?? '')) return true;
    if (BUSINESS_RE.test(cl[k])) return false;
  }
  return false;
}

/**
 * Guard identifier in masked code: a known guard name, or a local alias of one (see findGuardAliases).
 */
function isGuardText(codeText, aliasRe) {
  return AUTH_RE.test(codeText) || (aliasRe !== null && aliasRe.test(codeText));
}

/**
 * Local aliases of a known guard. A const, let or var assigned from a bare identifier or dotted name
 * that matches AUTH_RE, with an optional type annotation and optional `as` / `as unknown as` casts:
 *   const auth = authenticateToken as unknown as RequestHandler;
 * Anything else (a call, an unknown name, a value that is not a guard) is not an alias.
 * Returns { name, index } in source order. Input is masked code, so strings and comments never count.
 */
const ALIAS_DECL_RE = /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([A-Za-z_$][\w$.]*)\s*(?:as\s+unknown\s+as\s+[^;\n]+|as\s+[^;\n]+)?\s*(?:;|\n|$)/g;
export function findGuardAliases(code) {
  const out = [];
  const re = new RegExp(ALIAS_DECL_RE.source, 'g');
  let m;
  while ((m = re.exec(code))) {
    if (AUTH_RE.test(m[2])) out.push({ name: m[1], index: m.index });
  }
  return out;
}

/** Regex matching any of the given alias names as a whole identifier, or null when there are none. */
function aliasPattern(names) {
  if (names.length === 0) return null;
  const alts = names.map((n) => n.replace(/\$/g, '\\$'));
  return new RegExp(`(?<![\\w$])(?:${alts.join('|')})(?![\\w$])`);
}

/**
 * Split one call argument into the text outside its function bodies and whether a function body in it
 * has a guard in its preamble. Function bodies are removed from the outside text.
 */
function splitSegment(code, text, seg, aliasRe) {
  const c = code.slice(seg.start, seg.end);
  const t = text.slice(seg.start, seg.end);
  let outC = '';
  let outT = '';
  let cursor = 0;
  let inBody = false;
  const re = new RegExp(FUNC_RE.source, 'g');
  let f;
  while ((f = re.exec(c))) {
    const [bs, be] = functionBodySpan(c, f.index);
    outC += c.slice(cursor, bs);
    outT += t.slice(cursor, bs);
    cursor = be;
    if (preambleGuarded(c.slice(bs, be), t.slice(bs, be), aliasRe)) inBody = true;
    re.lastIndex = Math.max(be, f.index + 1);
  }
  outC += c.slice(cursor);
  outT += t.slice(cursor);
  return { outC, outT, inBody };
}

/**
 * Does one call argument count as a guard? Guard names (or aliases of them) outside function bodies count
 * anywhere in the argument. A function body counts only through its preamble (see preambleGuarded).
 */
function segmentGuarded(code, text, seg, aliasRe) {
  const { outC, outT, inBody } = splitSegment(code, text, seg, aliasRe);
  return inBody || isGuardText(outC, aliasRe) || HEADER_RE.test(outT);
}

const collapse = (s) => s.replace(/\s+/g, ' ').slice(0, 80);

/** Local arrays of handlers (const NAME = [ ... ]). start and end bound the items, without the brackets. */
function findHandlerArrays(code) {
  const out = [];
  const re = new RegExp(HANDLER_ARRAY_RE.source, 'g');
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    out.push({ name: m[1], index: m.index, start: open + 1, end: callEnd(code, open) - 1 });
  }
  return out;
}

/**
 * Names of local arrow helpers that pass a handler list to .use(): the param named in `...param` inside
 * the body must be forwarded to a .use() call. Calls to these helpers are mounts (see mountArgs).
 */
function findMountHelpers(code) {
  const names = new Set();
  const re = new RegExp(MOUNT_HELPER_RE.source, 'g');
  let m;
  while ((m = re.exec(code))) {
    const params = m[2].split(',').map((p) => p.trim().split(/[:=\s?]/)[0]).filter(Boolean);
    const open = m.index + m[0].length - 1;
    const body = code.slice(open + 1, callEnd(code, open) - 1);
    // the spread may be wrapped in a cast: ...(handlers as Foo[])
    const forwarded = params.some((p) => new RegExp(`\\.\\.\\.\\s*\\(?\\s*${p.replace(/\$/g, '\\$')}(?![\\w$])`).test(body));
    if (forwarded && /\.use\s*\(/.test(body)) names.add(m[1]);
  }
  return names;
}

/**
 * One mount call (app.use, a router .use, or a mount helper). Returns:
 *  - guarded: a known guard name sits in the args (outside function bodies), or in a local handler array
 *    declared before the call. Unknown identifiers never count.
 *  - flat: every identifier in the args (the routers and middleware it mounts), as before.
 *  - refs: { name, member } for each `name.member` in the args, so a namespace import (`ns.default`) can be resolved.
 */
function mountArgs(code, text, segs, aliasRe, arrays, index) {
  const arrayByName = new Map();
  for (const a of arrays) if (a.index < index) arrayByName.set(a.name, a); // last declaration before the call
  const spans = [...segs];
  for (const s of segs) {
    const { outC } = splitSegment(code, text, s, aliasRe);
    // a spread (...guards) names the array; a member access (x.guards) does not
    for (const id of outC.matchAll(/(?<![\w$]\s*\.)(?<![\w$])([A-Za-z_$][\w$]*)/g)) {
      const a = arrayByName.get(id[1]);
      if (a) spans.push({ start: a.start, end: a.end });
    }
  }
  let guarded = false;
  const flat = [];
  const refs = [];
  for (const s of spans) {
    const { outC, outT, inBody } = splitSegment(code, text, s, aliasRe);
    if (inBody || isGuardText(outC, aliasRe) || HEADER_RE.test(outT)) guarded = true;
    flat.push(...(outC.match(/[A-Za-z_$][\w$]*/g) ?? []));
    for (const r of outC.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
      refs.push({ name: r[1], member: r[2] ?? null });
    }
  }
  return { guarded, flat, refs };
}

/** Return every route definition and auth .use() call in one source file. */
export function scanSource(input) {
  const { code, text } = maskSource(input);
  const routes = [];
  const uses = [];
  // Guard aliases count only for calls written after their declaration (source order). A call that
  // runs before a module-level const would throw on load, so a later alias is never a guard here.
  const aliases = findGuardAliases(code);
  // Routers built in this file (const x = Router()). Their .use() calls can carry a guard (builder mount).
  const localRouters = new Set([...code.matchAll(new RegExp(LOCAL_ROUTER_RE.source, 'g'))].map((m) => m[1]));
  const arrays = findHandlerArrays(code);
  const callRe = new RegExp(ROUTE_CALL_SRC, 'g');
  let m;
  while ((m = callRe.exec(code))) {
    const [, receiver, method] = m;
    const isRouter = ROUTER_RECEIVER_RE.test(receiver);
    if (!isRouter && !(method === 'use' && localRouters.has(receiver))) continue;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = callEnd(code, openIdx) - 1;
    const segs = splitArgs(code, openIdx, closeIdx);
    const aliasRe = aliasPattern(aliases.filter((a) => a.index < m.index).map((a) => a.name));

    if (method === 'use') {
      const mount = mountArgs(code, text, segs, aliasRe, arrays, m.index);
      if (mount.guarded) uses.push({ receiver, index: m.index, mountIdents: mount.flat, mountRefs: mount.refs });
      continue;
    }
    if (!isRouter) continue;

    // Express route methods always take a path and a handler. One argument is a settings getter.
    if (segs.length < 2) continue;
    const first = segs[0];
    const pathCode = code.slice(first.start, first.end).trim();
    const pathText = text.slice(first.start, first.end).trim();
    let routePath;
    if (/^(['"])[ \n]*\1$/.test(pathCode)) routePath = pathText.slice(1, -1);
    else if (pathCode.startsWith('`')) routePath = `<template ${collapse(pathText)}>`;
    else if (/^[A-Za-z_$][\w$]*$/.test(pathCode)) routePath = `<${pathCode}>`;
    else routePath = `<expr ${collapse(pathText)}>`;

    const inlineAuth = segs.slice(1).some((s) => segmentGuarded(code, text, s, aliasRe));
    routes.push({
      receiver,
      method: method.toUpperCase(),
      path: routePath,
      index: m.index,
      inlineAuth,
    });
  }

  // Mount helpers: mountAt(prefix, [guard, router]) is a mount whose handlers the helper passes to .use().
  for (const name of findMountHelpers(code)) {
    const callRe2 = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
    let h;
    while ((h = callRe2.exec(code))) {
      const openIdx = h.index + h[0].length - 1;
      const segs = splitArgs(code, openIdx, callEnd(code, openIdx) - 1);
      const aliasRe = aliasPattern(aliases.filter((a) => a.index < h.index).map((a) => a.name));
      const mount = mountArgs(code, text, segs, aliasRe, arrays, h.index);
      if (mount.guarded) uses.push({ receiver: null, index: h.index, mountIdents: mount.flat, mountRefs: mount.refs });
    }
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
  // const { x } = await import('./mod'): destructured dynamic imports
  const dyn = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(src))) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const [imported, local] = p.split(/\s*:\s*/);
      map.set((local ?? imported).trim(), { spec: m[2], imported: imported.trim() });
    }
  }
  return map;
}

/** Follow export-from chains until the file that defines the name. */
function definingFile(files, rel, name, depth = 0) {
  if (depth > 8) return null;
  const src = files.get(rel);
  if (!src) return null;
  const defines = new RegExp(`(?:function|class|const|let|var)\\s+${name}\\b`).test(src);
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
/** Factory that built a local router before the given index: the last `const x = factory(` above it. */
function factoryOf(code, ident, before) {
  const re = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*(?:await\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
  let last = null;
  let f;
  while ((f = re.exec(code))) if (f.index < before && f[1] !== 'import') last = f[1];
  return last;
}

/** Name of the default export when it is a plain identifier: export default router. */
function defaultExportName(code) {
  return /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/.exec(code)?.[1] ?? null;
}

export function analyze(files) {
  const mountCovered = new Map(); // rel -> reason (whole file)
  const routerCovered = new Map(); // `${rel}#${variable}` -> reason (one router variable, e.g. a public router in the same file)
  const results = [];

  for (const [rel, src] of files) {
    const { code, text } = maskSource(src);
    const { routes, uses } = scanSource(src);
    const nsImports = new Map(); // const x = await import('spec')
    for (const n of text.matchAll(new RegExp(NS_IMPORT_RE.source, 'g'))) nsImports.set(n[1], n[2]);

    // (c) files named by an auth .use() call in this file (router or middleware imports).
    for (const use of uses) {
      for (const ident of new Set(use.mountIdents)) {
        if (AUTH_RE.test(ident)) continue; // a guard is not a router
        let target = resolveImported(files, rel, ident);
        // a local router built by a factory: const router = createXRouter(...), nearest declaration above the mount
        const factory = factoryOf(code, ident, use.index);
        if (!target && factory) target = resolveImported(files, rel, factory) ?? definingFile(files, rel, factory);
        if (target && !mountCovered.has(target)) mountCovered.set(target, `mounted behind auth in ${rel}`);
      }
      // (c2) namespace members of a dynamic import: ns.default or ns.someRouter. Covers that one router variable only.
      for (const ref of use.mountRefs) {
        if (!ref.member || !nsImports.has(ref.name)) continue;
        const target = resolveSpec(files, rel, nsImports.get(ref.name));
        if (!target || !files.has(target)) continue;
        const tcode = maskSource(files.get(target)).code;
        const variable = ref.member === 'default' ? defaultExportName(tcode) : ref.member;
        const declared = variable !== null && new RegExp(`(?:const|let|var)\\s+${variable}\\b`).test(tcode);
        if (!variable || (!declared && defaultExportName(tcode) !== variable)) continue;
        const key = `${target}#${variable}`;
        if (!routerCovered.has(key)) routerCovered.set(key, `mounted behind auth in ${rel}`);
      }
      if (use.receiver === null) continue; // helper mounts have no receiver for the register step
      // register functions called with the same router after the auth .use()
      const callRe = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\(\\s*${use.receiver}\\s*\\)`, 'g');
      let c;
      while ((c = callRe.exec(code))) {
        if (c.index <= use.index) continue;
        const target = resolveImported(files, rel, c[1]) ?? definingFile(files, rel, c[1]);
        if (target && !mountCovered.has(target)) mountCovered.set(target, `registered after auth on ${use.receiver} in ${rel}`);
      }
    }

    for (const route of routes) {
      let reason = null;
      if (route.inlineAuth) reason = 'inline guard';
      else if (uses.some((u) => u.receiver === route.receiver && u.index < route.index)) reason = 'same-file guard';
      results.push({ file: rel, method: route.method, path: route.path, receiver: route.receiver, reason });
    }
  }

  // (d) transitive registration: a file that is mounted behind auth and calls register functions
  // with its router (registerX(router)) puts those register files behind the same guard. Repeat until
  // no new file is added, so nested register chains are followed.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [rel, src] of files) {
      if (!mountCovered.has(rel)) continue;
      const { code } = maskSource(src);
      const routers = new Set([
        ...[...code.matchAll(new RegExp(ROUTE_CALL_SRC, 'g'))].map((m) => m[1]).filter((n) => ROUTER_RECEIVER_RE.test(n)),
        ...[...code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.)?Router\s*\(/g)].map((m) => m[1]),
      ]);
      for (const router of routers) {
        const callRe = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\(\\s*${router}\\s*\\)`, 'g');
        let c;
        while ((c = callRe.exec(code))) {
          const target = resolveImported(files, rel, c[1]);
          if (target && !mountCovered.has(target)) {
            mountCovered.set(target, `registered on a router mounted behind auth in ${rel}`);
            grew = true;
          }
        }
      }
    }
  }

  for (const r of results) {
    if (!r.reason && routerCovered.has(`${r.file}#${r.receiver}`)) r.reason = routerCovered.get(`${r.file}#${r.receiver}`);
    if (!r.reason && mountCovered.has(r.file)) r.reason = mountCovered.get(r.file);
  }
  return results;
}

export function keyOf(r) {
  return `${r.file}|${r.method}|${r.path}`;
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return [];
  const data = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  return Array.isArray(data.entries) ? data.entries : [];
}

// ---------- live analysis (computed once, shared by the live tests) ----------

let liveCache = null;
function liveAnalysis() {
  if (liveCache) return liveCache;
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
  const routeKeys = new Set(routes.map(keyOf));
  liveCache = {
    files,
    routes,
    allowed,
    covered: routes.filter((r) => r.reason),
    unlisted: routes.filter((r) => !r.reason && !allowed.has(keyOf(r))),
    stale: [...allowed].filter((k) => !routeKeys.has(k)),
    allowedButGuarded: [...allowed].filter((k) => routes.some((r) => keyOf(r) === k && r.reason)),
    countedAsUnparsed: routes.filter((r) => r.path.startsWith('<template') || r.path.startsWith('<expr')),
  };
  return liveCache;
}

// ---------- tests ----------

test('lexer: comment and string markers do not hide code', () => {
  const fixture = `
import { Router } from 'express';
const url = 'http://example.test/*';
const note = "/* not a comment";
// router.get('/commented-out', (req, res) => res.json({}));
/* router.get('/block-commented', (req, res) => res.json({})); */
router.get('/after-strings', (req, res) => res.json({ url, note }));
router.get('/after-line-comment', (req, res) => res.json({ tag: \`a /* b\` }));
`;
  const results = analyze(new Map([['server/lexer.ts', fixture]]));
  const paths = results.map((r) => r.path);
  assert.deepEqual(paths, ['/after-strings', '/after-line-comment']);
});

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

test('response text and guard names after business logic do not count as guards', () => {
  const fixture = `
import { Router } from 'express';
const router = Router();
router.post('/exchange', async (req, res) => {
  // the caller is authenticated by requireAuth in the mount
  res.status(403).json({ error: 'OAuth state does not match the authenticated user.' });
});
router.post('/late-guard', async (req, res) => {
  const rows = await db.select().from(t);
  requireAuth(req, res);
  res.json(rows);
});
router.post('/early-guard', async (req, res) => {
  requireAuth(req, res);
  const rows = await db.select().from(t);
  res.json(rows);
});
router.get('/template/:id', 'x', (req, res) => res.json({}));
`;
  const results = analyze(new Map([['server/guards.ts', fixture]]));
  const byPath = Object.fromEntries(results.map((r) => [r.path, r.reason]));
  assert.equal(byPath['/exchange'], null, 'authenticated in a string is not a guard');
  assert.equal(byPath['/late-guard'], null, 'guard after business logic does not count');
  assert.equal(byPath['/early-guard'], 'inline guard');
});

test('template-literal and expression paths are counted, not dropped', () => {
  const fixture = `
const streamPaths = ['/a', '/b'];
for (const p of streamPaths) {
  app.get(\`\${p}*\`, (req, res) => { res.json({}); });
}
`;
  const { routes } = scanSource(fixture);
  assert.equal(routes.length, 1);
  assert.ok(routes[0].path.startsWith('<template'), `got ${routes[0].path}`);
  assert.equal(routes[0].inlineAuth, false);
});

test('local alias of a known guard counts as a guard (plain, cast, let, and router.use)', () => {
  const fixture = `
import { Router } from 'express';
import { authenticateToken, requireAdmin } from './middleware/auth';
const router = Router();
const auth = authenticateToken as unknown as RequestHandler;
let guard: RequestHandler = requireAdmin as RequestHandler;
var plain = authenticateToken;
router.get('/cast-alias', auth, (req, res) => res.json({}));
router.post('/let-alias', guard, (req, res) => res.json({}));
router.get('/var-alias', plain, (req, res) => res.json({}));
const admin = requireAdmin;
router.use(admin);
router.delete('/after-alias-use', (req, res) => res.json({}));
`;
  const results = analyze(new Map([['server/alias.ts', fixture]]));
  const byPath = Object.fromEntries(results.map((r) => [r.path, r.reason]));
  assert.equal(byPath['/cast-alias'], 'inline guard');
  assert.equal(byPath['/let-alias'], 'inline guard');
  assert.equal(byPath['/var-alias'], 'inline guard');
  assert.equal(byPath['/after-alias-use'], 'same-file guard');
});

test('an identifier that is not a known guard alias does NOT count', () => {
  const fixture = `
import { Router } from 'express';
const router = Router();
const helper = makeHandler();
const notAuth = someHelper as unknown as RequestHandler;
const label = 'authenticateToken';
const built = buildAuth();
router.get('/unknown-alias', notAuth, (req, res) => res.json({}));
router.get('/call-result', built, (req, res) => res.json({}));
router.get('/string-name', label, (req, res) => res.json({}));
router.get('/helper', helper, (req, res) => res.json({}));
router.get('/no-guard', (req, res) => res.json({}));
`;
  const results = analyze(new Map([['server/unknown.ts', fixture]]));
  const byPath = Object.fromEntries(results.map((r) => [r.path, r.reason]));
  assert.equal(byPath['/unknown-alias'], null, 'alias of a non-guard name is not a guard');
  assert.equal(byPath['/call-result'], null, 'a call result is not an alias');
  assert.equal(byPath['/string-name'], null, 'a string is not an alias');
  assert.equal(byPath['/helper'], null);
  assert.equal(byPath['/no-guard'], null, 'a route with no guard is still flagged');
});

test('a guard alias declared after the route does not count (declared before use only)', () => {
  const fixture = `
import { Router } from 'express';
import { authenticateToken } from './middleware/auth';
const router = Router();
router.get('/before-alias', auth, (req, res) => res.json({}));
const auth = authenticateToken as unknown as RequestHandler;
router.get('/after-alias', auth, (req, res) => res.json({}));
`;
  const results = analyze(new Map([['server/order.ts', fixture]]));
  const byPath = Object.fromEntries(results.map((r) => [r.path, r.reason]));
  assert.equal(byPath['/before-alias'], null, 'a call before the const declaration is not guarded by it');
  assert.equal(byPath['/after-alias'], 'inline guard');
});

test('the real user-sip-gateways alias pattern is recognised', () => {
  const src = `
const auth = authenticateToken as unknown as import('express').RequestHandler;
`;
  assert.deepEqual(findGuardAliases(maskSource(src).code).map((a) => a.name), ['auth']);
});

test('route count sanity: scanner finds the real route set', (t) => {
  const { routes, files } = liveAnalysis();
  t.diagnostic(`reachable files: ${files.size}`);
  t.diagnostic(`routes counted: ${routes.length}, covered: ${liveAnalysis().covered.length}`);
  t.diagnostic(`template or expression paths counted: ${liveAnalysis().countedAsUnparsed.length}`);
  assert.ok(routes.length >= 300, `expected at least 300 routes, found ${routes.length}; scanner may be broken`);
});

test('every reachable server route is guarded or on the owner-approved allowlist', (t) => {
  const { unlisted, covered, routes, allowed } = liveAnalysis();
  t.diagnostic(`routes counted: ${routes.length}, covered: ${covered.length}, unlisted: ${unlisted.length}, allowlisted: ${allowed.size}`);
  assert.deepEqual(
    unlisted.map((r) => `${r.method} ${r.path}  (${r.file})`),
    [],
    'routes with no auth or permission guard and not on tests/security/route-auth-allowlist.json',
  );
});

test('allowlist has no stale entries (each entry matches a reachable route)', () => {
  assert.deepEqual(liveAnalysis().stale, [], 'allowlist entries that match no reachable route; remove them');
});

test('allowlist has no entries that are already guarded', () => {
  assert.deepEqual(liveAnalysis().allowedButGuarded, [], 'allowlist entries that are already guarded; remove them');
});

// ---------- mount-level guard awareness (fixtures) ----------

const ITEMS_ROUTER = `
import { Router } from 'express';
const router = Router();
router.get('/items', (req, res) => res.json({}));
export default router;
`;

function routesByPath(files) {
  return Object.fromEntries(analyze(new Map(Object.entries(files))).map((r) => [r.path, r.reason]));
}

test('a router mounted through a helper behind a known guard counts as guarded', () => {
  const byPath = routesByPath({
    'server/routes/items.ts': ITEMS_ROUTER,
    'server/index.ts': `
import itemRoutes from './routes/items';
import { authenticateToken } from './middleware/auth';
const mountAt = (prefix: string, handlers: RequestHandler[]): void => { app.use(prefix, ...(handlers as Foo[])); };
mountAt('/api/items', [authenticateToken, itemRoutes]);
`,
  });
  assert.ok(byPath['/items'], 'router mounted behind authenticateToken must be covered');
});

test('a router mounted with no guard through the same helper stays flagged', () => {
  const byPath = routesByPath({
    'server/routes/items.ts': ITEMS_ROUTER,
    'server/index.ts': `
import itemRoutes from './routes/items';
const mountAt = (prefix: string, handlers: RequestHandler[]): void => { app.use(prefix, ...handlers); };
mountAt('/api/open', [itemRoutes]);
`,
  });
  assert.equal(byPath['/items'], null, 'a mount with no guard must not cover the router');
});

test('a router mounted behind an unknown identifier stays flagged', () => {
  const byPath = routesByPath({
    'server/routes/items.ts': ITEMS_ROUTER,
    'server/index.ts': `
import itemRoutes from './routes/items';
const mountAt = (prefix: string, handlers: RequestHandler[]): void => { app.use(prefix, ...handlers); };
mountAt('/api/items', [runGate, itemRoutes]);
app.use('/api/more', runGate, itemRoutes);
`,
  });
  assert.equal(byPath['/items'], null, 'an unknown identifier is not a guard');
});

test('the public widget mount stays flagged (no guard, even through the same helper)', () => {
  const byPath = routesByPath({
    'server/modules/widget/router.ts': `
import { Router } from 'express';
const router = Router();
router.get('/:publicId/config', (req, res) => res.json({}));
export default router;
`,
    'server/index.ts': `
import widgetRoutes from './modules/widget/router';
const mountAt = (prefix: string, handlers: RequestHandler[]): void => { app.use(prefix, ...handlers); };
mountAt('/api/chatbot/widget', [widgetRoutes]);
`,
  });
  assert.equal(byPath['/:publicId/config'], null, 'widget mount with no guard stays flagged');
});

test('a namespace import mount covers only the router variable it names (public router stays flagged)', () => {
  const byPath = routesByPath({
    'server/routes/plugins.ts': `
import { Router } from 'express';
const router = Router();
export const publicRouter = Router();
router.get('/list', (req, res) => res.json({}));
publicRouter.get('/bundle', (req, res) => res.json({}));
export default router;
`,
    'server/index.ts': `
const pluginRoutes = await import('./routes/plugins');
app.use('/api/admin/plugins', checkAdminOrTeamMember, pluginRoutes.default);
app.use('/api/plugins', pluginRoutes.publicRouter);
`,
  });
  assert.ok(byPath['/list'], 'default router behind checkAdminOrTeamMember must be covered');
  assert.equal(byPath['/bundle'], null, 'publicRouter has no guard and must stay flagged');
});

test('a local router with a guarded .use() (builder-style mount) covers the router it mounts', () => {
  const byPath = routesByPath({
    'server/modules/builder/router.ts': `
import { Router } from 'express';
const router = Router();
router.get('/builder/:id', (req, res) => res.json({}));
export default router;
`,
    'server/index.ts': `
import builderRoutes from './modules/builder/router';
const builderMount = Router();
builderMount.use(modeGuard, deps.authenticate, deps.requireCompanyScope, builderRoutes);
app.use('/api/chatbot', builderMount);
`,
  });
  assert.ok(byPath['/builder/:id'], 'builderMount.use with authenticate must cover the builder router');
});

test('a handler array declared before the mount counts; one declared after does not', () => {
  const before = routesByPath({
    'server/routes/items.ts': ITEMS_ROUTER,
    'server/index.ts': `
import itemRoutes from './routes/items';
import { authenticateToken } from './middleware/auth';
const guards = [authenticateToken];
app.use('/api/items', ...guards, itemRoutes);
`,
  });
  assert.ok(before['/items'], 'guard array declared before the mount must count');
  const after = routesByPath({
    'server/routes/items.ts': ITEMS_ROUTER,
    'server/index.ts': `
import itemRoutes from './routes/items';
import { authenticateToken } from './middleware/auth';
app.use('/api/items', ...guards, itemRoutes);
const guards = [authenticateToken];
`,
  });
  assert.equal(after['/items'], null, 'a guard array declared after the mount is not a guard here');
});

test('factory routers: each mount uses the nearest router declaration above it', () => {
  const byPath = routesByPath({
    'server/agent/router.ts': `
import { Router } from 'express';
export function createAgentRouter() {
  const router = Router();
  router.get('/inbox', (req, res) => res.json({}));
  return router;
}
`,
    'server/widget/router.ts': `
import { Router } from 'express';
export function createWidgetRouter() {
  const router = Router();
  router.get('/:publicId/config', (req, res) => res.json({}));
  return router;
}
`,
    'server/index.ts': `
import { createAgentRouter } from './agent/router';
import { createWidgetRouter } from './widget/router';
import { authenticateToken } from './middleware/auth';
const mountAt = (prefix: string, handlers: RequestHandler[]): void => { app.use(prefix, ...handlers); };
{
  const router = createAgentRouter();
  mountAt('/api/agent', [authenticateToken, router]);
}
{
  const router = createWidgetRouter();
  mountAt('/api/widget', [router]);
}
`,
  });
  assert.ok(byPath['/inbox'], 'agent router mounted behind authenticateToken must be covered');
  assert.equal(byPath['/:publicId/config'], null, 'widget router mounted with no guard stays flagged');
});
