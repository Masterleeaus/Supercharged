/**
 * Tests for server/workforce/runtime/agent-memory.ts. In-memory, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/agent-memory.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMemory } from '../../server/workforce/runtime/agent-memory.ts';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const AGENT = 'agent-scheduler';
const OTHER_AGENT = 'agent-billing';
const HUMAN = 'user-jason';
const DAY = 24 * 60 * 60 * 1000;

const setup = (retentionMs = 30 * DAY) => {
  const clock = { t: 1_000_000 }
  const memory = createAgentMemory({ now: () => clock.t, retentionMs })
  return { memory, clock }
}

const summary = (text = 'Client prefers morning visits on Tuesdays.') => ({
  agentId: AGENT,
  text,
  source: { kind: 'summary' },
})

test('a pending entry is not recalled', () => {
  const { memory } = setup()
  const p = memory.propose(COMPANY_A, summary())
  assert.equal(p.ok, true)
  const r = memory.recall(COMPANY_A, AGENT)
  assert.deepEqual(r, { ok: true, entries: [] })
})

test('an approved entry is recalled for its company and agent only', () => {
  const { memory } = setup()
  const p = memory.propose(COMPANY_A, summary())
  assert.equal(memory.approve(COMPANY_A, p.entryId, HUMAN).ok, true)

  const r = memory.recall(COMPANY_A, AGENT)
  assert.equal(r.ok, true)
  assert.equal(r.entries.length, 1)
  assert.equal(r.entries[0].text, 'Client prefers morning visits on Tuesdays.')
  assert.equal(r.entries[0].status, 'approved')
  assert.equal(r.entries[0].approvedBy, HUMAN)

  assert.deepEqual(memory.recall(COMPANY_A, OTHER_AGENT).entries, [])
})

test('an expired approved entry is not recalled', () => {
  const { memory, clock } = setup(30 * DAY)
  const p = memory.propose(COMPANY_A, summary())
  memory.approve(COMPANY_A, p.entryId, HUMAN)

  clock.t += 30 * DAY - 1
  assert.equal(memory.recall(COMPANY_A, AGENT).entries.length, 1)

  clock.t += 1
  assert.deepEqual(memory.recall(COMPANY_A, AGENT).entries, [])
})

test('an agent cannot approve its own entry', () => {
  const { memory } = setup()
  const p = memory.propose(COMPANY_A, summary())
  assert.deepEqual(memory.approve(COMPANY_A, p.entryId, `agent:${AGENT}`), {
    ok: false,
    error: 'human_only',
  })
  assert.deepEqual(memory.recall(COMPANY_A, AGENT).entries, [])
})

test('approval needs a non-empty approver id', () => {
  const { memory } = setup()
  const p = memory.propose(COMPANY_A, summary())
  assert.equal(memory.approve(COMPANY_A, p.entryId, '').error, 'invalid_approver')
  assert.equal(memory.approve(COMPANY_A, p.entryId, '   ').error, 'invalid_approver')
  assert.equal(memory.approve(COMPANY_A, p.entryId, undefined).error, 'invalid_approver')
})

test('an entry cannot be approved twice', () => {
  const { memory } = setup()
  const p = memory.propose(COMPANY_A, summary())
  memory.approve(COMPANY_A, p.entryId, HUMAN)
  assert.equal(memory.approve(COMPANY_A, p.entryId, HUMAN).error, 'not_pending')
})

test('text with an email address is refused as sensitive content', () => {
  const { memory } = setup()
  const r = memory.propose(COMPANY_A, summary('Contact jane.doe@example.com about the quote.'))
  assert.deepEqual(r, { ok: false, error: 'sensitive_content' })
})

test('text with a phone number is refused as sensitive content', () => {
  const { memory } = setup()
  assert.equal(
    memory.propose(COMPANY_A, summary('Call the client on 0412 345 678 after 5pm.')).error,
    'sensitive_content',
  )
  assert.equal(
    memory.propose(COMPANY_A, summary('Reach them at +61 4 1234 5678.')).error,
    'sensitive_content',
  )
})

test('text with a card-like number is refused as sensitive content', () => {
  const { memory } = setup()
  assert.equal(
    memory.propose(COMPANY_A, summary('Card on file 4111 1111 1111 1111.')).error,
    'sensitive_content',
  )
  assert.equal(
    memory.propose(COMPANY_A, summary('Card 4111-1111-1111-1111 for the deposit.')).error,
    'sensitive_content',
  )
})

test('dates and short numbers are not refused as sensitive content', () => {
  const { memory } = setup()
  assert.equal(memory.propose(COMPANY_A, summary('Job booked for 03/11/2026 at 9:30, 2 technicians.')).ok, true)
})

test('text over 500 characters is refused', () => {
  const { memory } = setup()
  const r = memory.propose(COMPANY_A, summary('a'.repeat(501)))
  assert.deepEqual(r, { ok: false, error: 'text_too_long' })
  assert.equal(memory.propose(COMPANY_A, summary('a'.repeat(500))).ok, true)
})

test('a record source without recordId is refused', () => {
  const { memory } = setup()
  const r = memory.propose(COMPANY_A, {
    agentId: AGENT,
    text: 'Quote accepted.',
    source: { kind: 'record' },
  })
  assert.deepEqual(r, { ok: false, error: 'record_id_required' })
})

test('a record source with recordId is accepted', () => {
  const { memory } = setup()
  const p = memory.propose(COMPANY_A, {
    agentId: AGENT,
    text: 'Quote accepted.',
    source: { kind: 'record', recordId: 'quote-42' },
  })
  assert.equal(p.ok, true)
  memory.approve(COMPANY_A, p.entryId, HUMAN)
  assert.deepEqual(memory.recall(COMPANY_A, AGENT).entries[0].source, {
    kind: 'record',
    recordId: 'quote-42',
  })
})

test('an unknown source kind is refused', () => {
  const { memory } = setup()
  const r = memory.propose(COMPANY_A, { agentId: AGENT, text: 'x', source: { kind: 'web' } })
  assert.equal(r.error, 'invalid_source')
})

test('forget removes an entry in any status', () => {
  const { memory } = setup()
  const pending = memory.propose(COMPANY_A, summary('Pending note.'))
  const approved = memory.propose(COMPANY_A, summary('Approved note.'))
  memory.approve(COMPANY_A, approved.entryId, HUMAN)

  assert.deepEqual(memory.forget(COMPANY_A, pending.entryId), { ok: true })
  assert.deepEqual(memory.forget(COMPANY_A, approved.entryId), { ok: true })
  assert.deepEqual(memory.recall(COMPANY_A, AGENT).entries, [])

  assert.equal(memory.forget(COMPANY_A, approved.entryId).error, 'not_found')
  assert.equal(memory.approve(COMPANY_A, pending.entryId, HUMAN).error, 'not_found')
})

test('another company cannot recall or forget an entry', () => {
  const { memory } = setup()
  const p = memory.propose(COMPANY_A, summary())
  memory.approve(COMPANY_A, p.entryId, HUMAN)

  assert.deepEqual(memory.recall(COMPANY_B, AGENT).entries, [])
  assert.deepEqual(memory.forget(COMPANY_B, p.entryId), { ok: false, error: 'not_found' })
  assert.equal(memory.recall(COMPANY_A, AGENT).entries.length, 1)
})

test('another company cannot approve an entry it does not own', () => {
  const { memory } = setup()
  const p = memory.propose(COMPANY_A, summary())
  assert.deepEqual(memory.approve(COMPANY_B, p.entryId, HUMAN), { ok: false, error: 'not_found' })
  assert.deepEqual(memory.recall(COMPANY_A, AGENT).entries, [])
})

test('a non-UUID company id is refused on every method', () => {
  const { memory } = setup()
  const bad = 'company-1'
  assert.deepEqual(memory.propose(bad, summary()), { ok: false, error: 'invalid_company' })
  assert.deepEqual(memory.approve(bad, 'x', HUMAN), { ok: false, error: 'invalid_company' })
  assert.deepEqual(memory.recall(bad, AGENT), { ok: false, error: 'invalid_company' })
  assert.deepEqual(memory.forget(bad, 'x'), { ok: false, error: 'invalid_company' })
})

test('returned entries are copies, so callers cannot change stored memory', () => {
  const { memory } = setup()
  const p = memory.propose(COMPANY_A, summary())
  memory.approve(COMPANY_A, p.entryId, HUMAN)
  memory.recall(COMPANY_A, AGENT).entries[0].text = 'changed'
  assert.equal(memory.recall(COMPANY_A, AGENT).entries[0].text, 'Client prefers morning visits on Tuesdays.')
})
