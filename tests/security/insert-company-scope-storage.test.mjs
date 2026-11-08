// Insert company scope: every insert into a company-owned table must set company_id from the owning
// record or the verified session, never from the request body, and must refuse when neither exists.
//
// Two parts:
//  1. Static checks of the owned files (text based, no server imports, no database).
//  2. Behaviour of the two pure resolver helpers, extracted from source and transpiled with the
//     local typescript package, then evaluated. Nothing from server/ is imported.
//
// Run: node --test --experimental-transform-types tests/security/insert-company-scope-storage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
// Normalise CRLF so the line-based regexes below match regardless of checkout line endings.
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const ts = require('typescript');

const storageSrc = read('server/storage.ts');
const batchSrc = read('server/utils/batch-utils.ts');
const hydratorSrc = read('server/services/openai-voice-agent/hydrator.ts');
const routesSrc = read('server/routes/campaign-routes.ts');
const executorSrc = read('server/services/campaign-executor.ts');

// Body of a top-level or class-level function, from its signature to the next sibling at the same indent.
function sliceFunction(src, signatureRegex) {
  const m = src.match(signatureRegex);
  assert.ok(m, `signature not found: ${signatureRegex}`);
  const start = m.index;
  const indent = /^\s*/.exec(src.slice(src.lastIndexOf('\n', start) + 1))[0];
  const rest = src.slice(start + m[0].length);
  const endRe = new RegExp(`\\n${indent}\\}\\n`);
  const end = rest.search(endRe);
  return src.slice(start, start + m[0].length + (end === -1 ? rest.length : end));
}

// Extract a top-level function declaration by name, then transpile and evaluate it.
function loadPureHelper(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `helper ${name} not found`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end !== -1, `end of helper ${name} not found`);
  const text = src.slice(start, end + 3);
  const js = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(`${js}\nreturn ${name};`)();
}

// ---------- 1. Static checks ----------

test('storage.ts: shared resolver is defined and fails closed', () => {
  const fn = sliceFunction(storageSrc, /function resolveInsertCompanyId\(/);
  assert.match(fn, /found\.size === 0/);
  assert.match(fn, /found\.size > 1/);
  assert.match(fn, /throw new Error/);
  assert.doesNotMatch(fn, /req\.body|insertCampaign|insertContact|insertCall|webhook\b/);
});

test('storage.ts: the five insert methods scope every insert through the resolver', () => {
  const methods = ['createCampaign', 'createContact', 'createContacts', 'createCall', 'createWebhook', 'createWebhookLog'];
  for (const name of methods) {
    const fn = sliceFunction(storageSrc, new RegExp(`async ${name}\\(`));
    assert.match(fn, /resolveInsertCompanyId\(/, `${name} must call resolveInsertCompanyId`);
    assert.match(fn, /companyId\?: string\)/, `${name} must take optional companyId parameter`);
  }
});

test('storage.ts: companyId is written after the body spread so body values cannot override it', () => {
  const methods = ['createCampaign', 'createContact', 'createCall', 'createWebhook', 'createWebhookLog'];
  for (const name of methods) {
    const fn = sliceFunction(storageSrc, new RegExp(`async ${name}\\(`));
    const spreadAt = fn.search(/\.\.\.(insertCampaign|insertContact|insertCall|webhook|log)\b/);
    const setAt = fn.search(/companyId: resolveInsertCompanyId\(/);
    assert.ok(spreadAt !== -1 && setAt > spreadAt, `${name}: companyId must come after the spread`);
  }
  const bulk = sliceFunction(storageSrc, /async createContacts\(/);
  assert.match(bulk, /\.\.\.c,\s*companyId: resolveInsertCompanyId\(/);
});

test('storage.ts: interface declarations expose the optional companyId parameter', () => {
  assert.match(storageSrc, /createCampaign\(campaign: InsertCampaign, companyId\?: string\)/);
  assert.match(storageSrc, /createContacts\(contacts: InsertContact\[\], companyId\?: string\)/);
  assert.match(storageSrc, /createWebhookLog\(log: InsertWebhookLog, companyId\?: string\)/);
});

test('batch-utils: each batch insert resolves company per row and refuses unresolved rows', () => {
  for (const name of ['batchInsertCalls', 'batchInsertFlowExecutions', 'batchInsertContacts']) {
    const fn = sliceFunction(batchSrc, new RegExp(`export async function ${name}\\(`));
    assert.match(fn, /resolveRowCompanyId\(options\.companyId/, `${name} must resolve company`);
    assert.match(fn, /if \(!companyId\) \{[\s\S]*?failed\+\+/, `${name} must count refused rows as failed`);
    assert.match(fn, /continue;/, `${name} must skip refused rows`);
  }
});

test('batch-utils: inserts only receive rows that carry a resolved companyId', () => {
  assert.match(batchSrc, /const callInserts: Array<InsertCall & \{ companyId: string \}> = \[\];/);
  assert.match(batchSrc, /const contactInserts: Array<InsertContact & \{ companyId: string \}> = \[\];/);
  assert.match(batchSrc, /const scopedExecutions: Array<FlowExecutionInsert & \{ companyId: string \}> = \[\];/);
  assert.match(batchSrc, /companyId: exec\.companyId,/);
  // Every db.insert in this file must use one of the scoped arrays or a row derived from them.
  const valuesArgs = [...batchSrc.matchAll(/db\s*\.insert\((calls|flowExecutions|contacts)\)\s*\.values\((\w+)\)/g)].map(m => m[2]);
  assert.ok(valuesArgs.length >= 6, `expected at least 6 batch inserts, found ${valuesArgs.length}`);
  for (const arg of valuesArgs) {
    assert.ok(['chunk', 'callInsert', 'execInsert', 'contactInsert'].includes(arg), `unexpected insert argument ${arg}`);
  }
});

test('batch-utils: company is never read from a row body or option other than the session', () => {
  assert.doesNotMatch(batchSrc, /\.companyId\s*\?\?\s*options/);
  assert.doesNotMatch(batchSrc, /req\.body/);
  assert.match(batchSrc, /options\.companyId/);
});

test('hydrator: appointment insert takes company from the owning agent record', () => {
  const fn = sliceFunction(hydratorSrc, /function createAppointmentHandler\(/);
  assert.match(fn, /select\(\{ flowId: agents\.flowId, companyId: agents\.companyId \}\)/);
  assert.match(fn, /if \(!agent\?\.companyId\) \{[\s\S]*?return \{[\s\S]*?success: false/);
  assert.match(fn, /companyId: appointmentCompanyId,/);
  // The guard must come before the insert.
  assert.ok(fn.indexOf('if (!agent?.companyId)') < fn.indexOf('.insert(appointments)'));
});

test('hydrator: form submission insert takes company from the owning form record', () => {
  const fn = sliceFunction(hydratorSrc, /function createFormSubmissionHandler\(/);
  assert.match(fn, /if \(!form\.companyId\) \{[\s\S]*?success: false/);
  assert.match(fn, /companyId: form\.companyId,/);
  assert.ok(fn.indexOf('if (!form.companyId)') < fn.indexOf('.insert(formSubmissions)'));
});

test('hydrator: the knowledge base handler is not touched by this change', () => {
  assert.match(hydratorSrc, /function createKnowledgeBaseHandler\(/);
});

test('campaign-routes: test-call insert takes company from campaign and session and refuses conflicts', () => {
  const idx = routesSrc.indexOf('const testCallCompanyIds');
  assert.ok(idx !== -1, 'company resolution missing from test-call route');
  const insertIdx = routesSrc.indexOf('companyId: testCallCompanyIds[0],', idx);
  assert.ok(insertIdx !== -1, 'calls insert must set companyId');
  const block = routesSrc.slice(idx, insertIdx);
  assert.match(block, /campaign\.companyId, res\.locals\.companyId/);
  assert.match(block, /new Set\(testCallCompanyIds\)\.size !== 1/);
  assert.match(block, /status\(403\)/);
});

test('campaign-executor: call insert in makeCall takes company from contact and campaign', () => {
  const fn = sliceFunction(executorSrc, /private async makeCall\(/);
  assert.match(fn, /\[contact\.companyId, owningCampaign\?\.companyId\]/);
  assert.match(fn, /new Set\(callCompanyIds\)\.size !== 1/);
  assert.match(fn, /companyId: callCompanyIds\[0\],/);
});

test('owned files: no insert takes company from req.body or an unsanitised body field', () => {
  for (const src of [storageSrc, batchSrc, hydratorSrc, routesSrc, executorSrc]) {
    assert.doesNotMatch(src, /companyId:\s*req\.body/);
    assert.doesNotMatch(src, /companyId:\s*body\./);
    assert.doesNotMatch(src, /companyId:\s*params\.companyId/);
  }
});

// ---------- 2. Behaviour of the pure helpers ----------

const resolveInsertCompanyId = loadPureHelper(storageSrc, 'resolveInsertCompanyId');
const resolveRowCompanyId = loadPureHelper(batchSrc, 'resolveRowCompanyId');

test('resolveInsertCompanyId: owner company alone is accepted', () => {
  assert.equal(resolveInsertCompanyId('x', undefined, ['c1']), 'c1');
});

test('resolveInsertCompanyId: session company alone is accepted', () => {
  assert.equal(resolveInsertCompanyId('x', 'c1', [null, undefined]), 'c1');
});

test('resolveInsertCompanyId: matching session and owner are accepted', () => {
  assert.equal(resolveInsertCompanyId('x', 'c1', ['c1', 'c1']), 'c1');
});

test('resolveInsertCompanyId: no company source refuses', () => {
  assert.throws(() => resolveInsertCompanyId('x', undefined, [null, undefined]), /company scope unavailable/);
  assert.throws(() => resolveInsertCompanyId('x', '', []), /company scope unavailable/);
});

test('resolveInsertCompanyId: conflicting sources refuse', () => {
  assert.throws(() => resolveInsertCompanyId('x', 'c1', ['c2']), /company scope mismatch/);
  assert.throws(() => resolveInsertCompanyId('x', undefined, ['c1', 'c2']), /company scope mismatch/);
});

test('resolveRowCompanyId: resolves the same way as the storage resolver', () => {
  assert.equal(resolveRowCompanyId(undefined, ['c1', undefined]), 'c1');
  assert.equal(resolveRowCompanyId('c1', [null]), 'c1');
  assert.equal(resolveRowCompanyId('c1', ['c1']), 'c1');
});

test('resolveRowCompanyId: returns null (refuse) when nothing is known or sources conflict', () => {
  assert.equal(resolveRowCompanyId(undefined, [null, undefined]), null);
  assert.equal(resolveRowCompanyId('c1', ['c2']), null);
  assert.equal(resolveRowCompanyId(undefined, ['c1', 'c2']), null);
});
