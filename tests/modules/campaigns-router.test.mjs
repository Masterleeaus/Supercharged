// Campaigns HTTP router (node:test). Recording fakes for most tests; the last test drives the
// real in-memory campaign service through the router to check company isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaignsRouter } from '../../server/modules/campaigns/campaigns-router.ts';
import {
  createCampaignService,
  CampaignError,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
} from '../../server/modules/campaigns/index.ts';
import { requireModule } from '../../server/modules/desk-modes/index.ts';
import {
  commsStack,
  recordingService,
  fakeRequireRole,
  sessionScope,
  HUMAN_SESSION,
  AGENT_SESSION,
  OTHER_COMPANY_SESSION,
  COMMS_HOST,
  WORKFORCE_HOST,
} from './support/comms-router-harness.mjs';

function build(methods) {
  const { service, calls } = recordingService(methods);
  const stack = commsStack((router) =>
    createCampaignsRouter({ router, service, scope: sessionScope, modeGuard: requireModule('campaigns'), requireRole: fakeRequireRole }),
  );
  return { stack, calls };
}

test('workforce host is refused on every campaigns route and no service call is made', async () => {
  const { stack, calls } = build();
  const requests = [
    ['POST', '/audiences'],
    ['GET', '/audiences/a1/resolution'],
    ['POST', '/contacts'],
    ['POST', '/opt-ins'],
    ['POST', '/unsubscribes'],
    ['POST', '/campaigns'],
    ['POST', '/campaigns/c1/steps'],
    ['POST', '/campaigns/c1/activation'],
    ['POST', '/campaigns/c1/steps/s1/send-request'],
    ['GET', '/jobs'],
  ];
  for (const [method, path] of requests) {
    const r = await stack.dispatch(method, path, { host: WORKFORCE_HOST, session: HUMAN_SESSION, body: {} });
    assert.equal(r.status, 404, `${method} ${path} should be refused in workforce mode`);
  }
  assert.equal(calls.length, 0);
});

test('no session means 401 and no service call', async () => {
  const { stack, calls } = build();
  const r = await stack.dispatch('POST', '/audiences', {
    host: COMMS_HOST,
    body: { name: 'VIP', channel: 'email', tagsAll: ['vip'] },
  });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test('defining an audience uses the session company and drops body company keys', async () => {
  const { stack, calls } = build({ defineAudience: async () => ({ id: 'a1' }) });
  const r = await stack.dispatch('POST', '/audiences', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    body: { company_id: '22222222-2222-4222-8222-222222222222', name: 'VIP', channel: 'email', tagsAll: ['vip'] },
  });
  assert.equal(r.status, 201);
  assert.equal(calls[0].method, 'defineAudience');
  assert.equal(calls[0].args[0], '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(calls[0].args[1], { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
});

test('send-request takes the actor from the session, not from the body', async () => {
  const { stack, calls } = build();
  await stack.dispatch('POST', '/campaigns/c1/steps/s1/send-request', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    body: { actor: { kind: 'human', id: 'someone-else' } },
  });
  assert.equal(calls[0].method, 'requestSend');
  assert.equal(calls[0].args[0], '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(calls[0].args[1], HUMAN_SESSION.actor);
  assert.equal(calls[0].args[2], 'c1');
  assert.equal(calls[0].args[3], 's1');
});

test('an agent session is refused on staff-only send requests and no service call is made', async () => {
  const { stack, calls } = build();
  const r = await stack.dispatch('POST', '/campaigns/c1/steps/s1/send-request', {
    host: COMMS_HOST,
    session: AGENT_SESSION,
    body: {},
  });
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
});

test('activation passes the session actor and the campaign id', async () => {
  const { stack, calls } = build();
  await stack.dispatch('POST', '/campaigns/c1/activation', { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(calls[0].method, 'activateCampaign');
  assert.deepEqual(calls[0].args[1], HUMAN_SESSION.actor);
  assert.equal(calls[0].args[2], 'c1');
});

test('job listing filters by known query keys only', async () => {
  const { stack, calls } = build({ listJobs: async () => [] });
  await stack.dispatch('GET', '/jobs', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    query: { campaignId: 'c1', approvalId: 'ap1', companyId: '22222222-2222-4222-8222-222222222222', junk: 'x' },
  });
  assert.equal(calls[0].args[0], '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(calls[0].args[1], { campaignId: 'c1', approvalId: 'ap1' });
});

test('the dispatch and release routes are not mounted, so they return 404 in comms mode', async () => {
  const { stack, calls } = build();
  const dispatch = await stack.dispatch('POST', '/jobs/j1/dispatch', { host: COMMS_HOST, session: HUMAN_SESSION });
  const release = await stack.dispatch('POST', '/approvals/ap1/release', { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(dispatch.status, 404);
  assert.equal(release.status, 404);
  assert.equal(calls.length, 0);
});

test('a refused send from the service becomes a 422', async () => {
  const { stack } = build({
    requestSend: () => {
      throw new CampaignError('Audience has no opt-in records on this channel', 'refused');
    },
  });
  const r = await stack.dispatch('POST', '/campaigns/c1/steps/s1/send-request', { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(r.status, 422);
});

test('real in-memory service: an audience defined by one company cannot be resolved by another', async () => {
  const store = new InMemoryCampaignStore();
  const approvals = new InMemoryApprovalPort();
  const transport = new RecordingSendTransport();
  let seq = 0;
  const service = createCampaignService({ store, approvals, transport, newId: () => `id_${++seq}` });
  const fake = commsStack((router) =>
    createCampaignsRouter({ router, service, scope: sessionScope, modeGuard: requireModule('campaigns'), requireRole: fakeRequireRole }),
  );

  const created = await fake.dispatch('POST', '/audiences', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    body: { name: 'VIP', channel: 'email', tagsAll: ['vip'] },
  });
  assert.equal(created.status, 201);
  const audienceId = created.body.id;

  const own = await fake.dispatch('GET', `/audiences/${audienceId}/resolution`, { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(own.status, 200);
  assert.equal(own.body.optInCount, 0);

  const other = await fake.dispatch('GET', `/audiences/${audienceId}/resolution`, { host: COMMS_HOST, session: OTHER_COMPANY_SESSION });
  assert.equal(other.status, 404);
});

test('an invalid authenticated company cannot resolve audience or create contacts', async () => {
  const { stack, calls } = build();
  const session = { ...HUMAN_SESSION, companyId: 'not-a-company' };
  const first = await stack.dispatch('GET','/audiences/a1/resolution',{host:COMMS_HOST,session});
  const second = await stack.dispatch('POST','/contacts',{host:COMMS_HOST,session,body:{channel:'email',address:'a@b.test'}});
  assert.equal(first.status,401);
  assert.equal(second.status,401);
  assert.equal(calls.length,0);
});

test('campaign actions refuse malformed actor sessions before service invocation',async()=>{
 const {stack,calls}=build();
 for(const actor of [null,{kind:'human',id:'  '},{kind:'system',id:'u'}]){
  const r=await stack.dispatch('POST','/campaigns/c1/activation',{host:COMMS_HOST,session:{...HUMAN_SESSION,actor}});
  assert.equal(r.status,401);
 }
 assert.equal(calls.length,0);
});
