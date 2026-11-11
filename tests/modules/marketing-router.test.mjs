// Marketing HTTP router (node:test). Recording fakes for most tests; the last test drives the
// real in-memory marketing service through the router to check company isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketingRouter } from '../../server/modules/marketing/marketing-router.ts';
import { createMarketingService, InMemoryMarketingStore, InMemoryRefs } from '../../server/modules/marketing/index.ts';
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
    createMarketingRouter({ router, service, scope: sessionScope, modeGuard: requireModule('marketing'), requireRole: fakeRequireRole }),
  );
  return { stack, calls };
}

test('workforce host is refused on every marketing route and no service call is made', async () => {
  const { stack, calls } = build();
  const requests = [
    ['GET', '/pages'],
    ['GET', '/pages/p1'],
    ['POST', '/pages'],
    ['PATCH', '/pages/p1'],
    ['POST', '/pages/p1/publication'],
    ['POST', '/pages/p1/archive'],
    ['GET', '/content'],
    ['GET', '/content/c1'],
    ['POST', '/content'],
    ['PATCH', '/content/c1'],
    ['POST', '/content/c1/approval'],
    ['POST', '/content/c1/publication'],
  ];
  for (const [method, path] of requests) {
    const r = await stack.dispatch(method, path, { host: WORKFORCE_HOST, session: HUMAN_SESSION, body: {} });
    assert.equal(r.status, 404, `${method} ${path} should be refused in workforce mode`);
  }
  assert.equal(calls.length, 0);
});

test('no session means 401 and no service call', async () => {
  const { stack, calls } = build();
  const r = await stack.dispatch('GET', '/pages', { host: COMMS_HOST });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
});

test('creating a page uses the session company and actor and drops body company keys', async () => {
  const { stack, calls } = build({ createPage: async () => ({ id: 'p1' }) });
  const r = await stack.dispatch('POST', '/pages', {
    host: COMMS_HOST,
    session: AGENT_SESSION,
    body: {
      company_id: '22222222-2222-4222-8222-222222222222',
      actor: { kind: 'human', id: 'boss' },
      slug: 'spring-offer',
      title: 'Spring offer',
    },
  });
  assert.equal(r.status, 201);
  assert.equal(calls[0].args[0], '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(calls[0].args[1], AGENT_SESSION.actor);
  assert.equal(calls[0].args[2].slug, 'spring-offer');
  assert.equal(calls[0].args[2].company_id, undefined);
});

test('a patch passes only the fields the client sent; absent fields stay undefined', async () => {
  const { stack, calls } = build();
  await stack.dispatch('PATCH', '/pages/p1', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    body: { title: 'New title' },
  });
  const input = calls[0].args[3];
  assert.equal(input.title, 'New title');
  assert.equal(input.sections, undefined);
  assert.equal(input.campaignId, undefined);
});

test('publishing and approving take the session actor', async () => {
  const { stack, calls } = build();
  await stack.dispatch('POST', '/pages/p1/publication', { host: COMMS_HOST, session: HUMAN_SESSION });
  await stack.dispatch('POST', '/content/c1/approval', { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(calls[0].method, 'publishPage');
  assert.deepEqual(calls[0].args[1], HUMAN_SESSION.actor);
  assert.equal(calls[1].method, 'approveContent');
  assert.deepEqual(calls[1].args[1], HUMAN_SESSION.actor);
});

test('an unknown page status filter is a 400 and the service is not called', async () => {
  const { stack, calls } = build();
  const r = await stack.dispatch('GET', '/pages', { host: COMMS_HOST, session: HUMAN_SESSION, query: { status: 'live' } });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test('a valid content kind filter reaches the service', async () => {
  const { stack, calls } = build({ listContent: async () => [] });
  await stack.dispatch('GET', '/content', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    query: { kind: 'blog_post', companyId: '22222222-2222-4222-8222-222222222222' },
  });
  assert.equal(calls[0].args[0], '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(calls[0].args[1], { kind: 'blog_post' });
});

test('real in-memory service: a page from one company is invisible to another', async () => {
  const store = new InMemoryMarketingStore();
  const refs = new InMemoryRefs();
  let seq = 0;
  const service = createMarketingService({ store, campaigns: refs, chatbots: refs, newId: () => `id_${++seq}` });
  const fake = commsStack((router) =>
    createMarketingRouter({ router, service, scope: sessionScope, modeGuard: requireModule('marketing'), requireRole: fakeRequireRole }),
  );

  const created = await fake.dispatch('POST', '/pages', {
    host: COMMS_HOST,
    session: HUMAN_SESSION,
    body: { slug: 'spring-offer', title: 'Spring offer' },
  });
  assert.equal(created.status, 201);

  const own = await fake.dispatch('GET', `/pages/${created.body.id}`, { host: COMMS_HOST, session: HUMAN_SESSION });
  assert.equal(own.status, 200);

  const other = await fake.dispatch('GET', `/pages/${created.body.id}`, { host: COMMS_HOST, session: OTHER_COMPANY_SESSION });
  assert.equal(other.status, 404);

  const list = await fake.dispatch('GET', '/pages', { host: COMMS_HOST, session: OTHER_COMPANY_SESSION });
  assert.equal(list.body.length, 0);
});

test('an invalid authenticated company cannot read marketing pages', async () => {
  const { stack, calls } = build();
  const session = { ...HUMAN_SESSION, companyId: 'not-a-company' };
  const result = await stack.dispatch('GET','/pages',{host:COMMS_HOST,session});
  assert.equal(result.status,401);
  assert.equal(calls.length,0);
});

test('marketing refuses malformed or absent actors before a content write',async()=>{
 const {stack,calls}=build();
 for(const actor of [null,{kind:'human',id:'  '},{kind:'system',id:'u'}]){
  const r=await stack.dispatch('POST','/content',{host:COMMS_HOST,session:{...HUMAN_SESSION,actor},body:{kind:'article',title:'x',body:'y'}});
  assert.equal(r.status,401);
 }
 assert.equal(calls.length,0);
});

test('a marketing page cannot be created with an unverified tenant identifier',async()=>{
 const {stack,calls}=build();
 const result=await stack.dispatch('POST','/pages',{host:COMMS_HOST,session:{...HUMAN_SESSION,companyId:'c1'},body:{slug:'example',title:'Page'}});
 assert.equal(result.status,401);assert.equal(calls.length,0);
});

test('marketing lists content for company B and never accepts caller-supplied company A',async()=>{
 const {stack,calls}=build({listContent:async()=>[]});
 const result=await stack.dispatch('GET','/content',{host:COMMS_HOST,session:OTHER_COMPANY_SESSION,query:{companyId:HUMAN_SESSION.companyId}});
 assert.equal(result.status,200);
 assert.equal(calls[0].args[0],OTHER_COMPANY_SESSION.companyId);
});
