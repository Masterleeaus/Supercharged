// Inbox HTTP router (node:test). The router is built on the injected fake router in
// support/. Services are recording fakes, except the last test, which uses the real
// in-memory inbox service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxRouter } from '../../server/modules/inbox/inbox-router.ts';
import { createInboxService, InMemoryInboxStore, InMemoryApprovalPort } from '../../server/modules/inbox/index.ts';
import { requireModule } from '../../server/modules/desk-modes/index.ts';
import {
  commsStack,
  recordingService,
  fakeRequireRole,
  sessionScope,
  HUMAN_SESSION,
  OTHER_COMPANY_SESSION,
  AGENT_SESSION,
  COMMS_HOST,
  WORKFORCE_HOST,
} from './support/comms-router-harness.mjs';

function build(methods) {
  const { service, calls } = recordingService(methods);
  const stack = commsStack((router) =>
    createInboxRouter({ router, service, scope: sessionScope, modeGuard: requireModule('inbox'), requireRole: fakeRequireRole }),
  );
  return { stack, calls };
}

const HUMAN_ACTOR = { kind: 'human', id: 'user-1' };

test('workforce host is refused on every inbox route and no service call is made', async () => {
  const { stack, calls } = build();
  const requests = [
    ['GET', '/threads'],
    ['GET', '/threads/t1'],
    ['GET', '/threads/t1/messages'],
    ['POST', '/threads/t1/assignment'],
    ['POST', '/threads/t1/status'],
    ['POST', '/threads/t1/drafts'],
    ['POST', '/threads/t1/messages'],
    ['POST', '/messages/m1/send-request'],
  ];
  for (const [method, path] of requests) {
    const r = await stack.dispatch(method, path, { host: WORKFORCE_HOST, session: HUMAN_SESSION, body: { body: 'hi' } });
    assert.equal(r.status, 404, `${method} ${path} should be refused in workforce mode`);
  }
  assert.equal(calls.length, 0);
});

test('a request with no host header is refused and no service call is made', async () => {
  const { stack, calls } = build();
  const r = await stack.dispatch('GET', '/threads', { session: HUMAN_SESSION });
  assert.equal(r.status, 404);
  assert.equal(calls.length, 0);
});

test('comms host with a session lists threads for the session company only', async () => {
  const { stack, calls } = build({ listThreads: async () => [{ id: 't1' }] });
  const r = await stack.dispatch('GET', '/threads', { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [{ id: 't1' }]);
  assert.equal(calls[0].method, 'listThreads');
  assert.equal(calls[0].args[0], '11111111-1111-4111-8111-111111111111');
});

test('no session means 401 and no service call', async () => {
  const { stack, calls } = build();
  const r = await stack.dispatch('GET', '/threads', { host: COMMS_HOST });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test('company_id in the body is ignored; the session company wins', async () => {
  const { stack, calls } = build();
  const r = await stack.dispatch('POST', '/threads/t1/status', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    body: { company_id: '22222222-2222-4222-8222-222222222222', companyId: '22222222-2222-4222-8222-222222222222', status: 'closed' },
  });
  assert.equal(r.status, 200);
  assert.equal(calls[0].args[0], '11111111-1111-4111-8111-111111111111');
  assert.equal(calls[0].args[3], 'closed');
});

test('company_id in the query string is ignored as well', async () => {
  const { stack, calls } = build({ listThreads: async () => [] });
  await stack.dispatch('GET', '/threads', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    query: { company_id: '22222222-2222-4222-8222-222222222222' },
  });
  assert.equal(calls[0].args[0], '11111111-1111-4111-8111-111111111111');
});

test('an invalid status filter is a 400 and the service is not called', async () => {
  const { stack, calls } = build();
  const r = await stack.dispatch('GET', '/threads', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    query: { status: 'deleted' },
  });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('a missing assignee field is passed through as undefined, not turned into an unassign', async () => {
  const { stack, calls } = build();
  await stack.dispatch('POST', '/threads/t1/assignment', { host: COMMS_HOST, session: HUMAN_SESSION, body: {} });
  assert.equal(calls[0].args[3], undefined);
  await stack.dispatch('POST', '/threads/t1/assignment', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    body: { assignee: null },
  });
  assert.equal(calls[1].args[3], null, 'an explicit null is still a deliberate unassign');
});

test('the actor comes from the session, not from a body field', async () => {
  const { stack, calls } = build();
  await stack.dispatch('POST', '/threads/t1/drafts', {
    host: COMMS_HOST,
    session: AGENT_SESSION,
    body: { body: 'draft text', actor: { kind: 'human', id: 'boss' } },
  });
  assert.deepEqual(calls[0].args[1], AGENT_SESSION.actor);
  assert.equal(calls[0].args[2], 't1');
  assert.equal(calls[0].args[3], 'draft text');
});

test('drafts and staff sends return 201; send-request passes the message id', async () => {
  const { stack, calls } = build();
  const draft = await stack.dispatch('POST', '/threads/t1/drafts', { host: COMMS_HOST, session: HUMAN_SESSION, body: { body: 'a' } });
  const send = await stack.dispatch('POST', '/threads/t1/messages', { host: COMMS_HOST, session: HUMAN_SESSION, body: { body: 'b' } });
  const req = await stack.dispatch('POST', '/messages/m9/send-request', { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(draft.status, 201);
  assert.equal(send.status, 201);
  assert.equal(req.status, 200);
  assert.equal(calls[0].method, 'createDraft');
  assert.equal(calls[1].method, 'sendAsStaff');
  assert.equal(calls[2].method, 'requestSend');
  assert.equal(calls[2].args[2], 'm9');
  assert.deepEqual(calls[2].args[1], HUMAN_ACTOR);
});

test('service not_found becomes a 404 with the service message', async () => {
  const { stack } = build({
    getThread: () => {
      throw Object.assign(new Error('Thread not found'), { code: 'not_found' });
    },
  });
  const r = await stack.dispatch('GET', '/threads/nope', { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'Thread not found' });
});

test('real in-memory service: the router returns only the session company threads', async () => {
  const store = new InMemoryInboxStore();
  const approvals = new InMemoryApprovalPort();
  let seq = 0;
  const service = createInboxService({ store, approvals, newId: () => `id_${++seq}` });
  await service.recordInbound('11111111-1111-4111-8111-111111111111', {
    channel: 'email',
    address: 'ana@example.com',
    body: 'Hello',
    externalId: 'ext-1',
  });

  const fake = commsStack((router) =>
    createInboxRouter({ router, service, scope: sessionScope, modeGuard: requireModule('inbox'), requireRole: fakeRequireRole }),
  );

  const mine = await fake.dispatch('GET', '/threads', { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.length, 1);

  const theirs = await fake.dispatch('GET', '/threads', { host: COMMS_HOST, session: OTHER_COMPANY_SESSION });
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.length, 0);
});
