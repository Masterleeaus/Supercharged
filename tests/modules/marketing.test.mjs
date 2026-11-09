// Marketing module tests (node:test). No database, no network. Campaign and chatbot references
// are seeded fakes, so the module never touches the campaigns or chatbot modules at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarketingService,
  MarketingError,
  InMemoryMarketingStore,
  InMemoryRefs,
  assertSections,
} from '../../server/modules/marketing/index.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const HUMAN = { kind: 'human', id: 'user-1' };
const AGENT = { kind: 'agent', id: 'agent-7' };

function build() {
  const store = new InMemoryMarketingStore();
  const refs = new InMemoryRefs();
  let seq = 0;
  let clock = 0;
  const service = createMarketingService({
    store,
    campaigns: refs,
    chatbots: refs,
    newId: () => `id_${++seq}`,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
  });
  return { store, refs, service };
}

const page = (over = {}) => ({ slug: 'spring-offer', title: 'Spring offer', ...over });
const hero = [{ kind: 'hero', props: { headline: 'Clean homes, booked online', cta: 'Book now', rating: 4.9, featured: true, tags: ['bond', 'end-of-lease'] } }];

// --- landing pages ---------------------------------------------------------

test('createPage: a draft with structured sections, stored with the author', async () => {
  const ctx = build();
  const p = await ctx.service.createPage(CO_A, AGENT, page({ sections: hero }));

  assert.equal(p.status, 'draft');
  assert.equal(p.companyId, CO_A);
  assert.equal(p.authorKind, 'agent');
  assert.equal(p.authorId, AGENT.id);
  assert.equal(p.publishedAt, null);
  assert.equal(p.sections[0].props.rating, 4.9);
});

test('createPage: slug must be lowercase letters, digits and single hyphens', async () => {
  const ctx = build();
  for (const bad of ['Spring', 'spring offer', 'spring--offer', '-spring', 'a', '']) {
    await assert.rejects(ctx.service.createPage(CO_A, HUMAN, page({ slug: bad })), (e) => e.code === 'invalid', bad);
  }
});

test('createPage: a duplicate slug in the same company is a conflict, and another company may reuse it', async () => {
  const ctx = build();
  await ctx.service.createPage(CO_A, HUMAN, page());
  await assert.rejects(ctx.service.createPage(CO_A, HUMAN, page()), (e) => e.code === 'conflict');
  const b = await ctx.service.createPage(CO_B, HUMAN, page());
  assert.equal(b.companyId, CO_B);
});

test('sections: angle brackets, unknown kinds and non-plain values are refused', async () => {
  const ctx = build();
  await assert.rejects(
    ctx.service.createPage(CO_A, HUMAN, page({ sections: [{ kind: 'text', props: { body: '<script>alert(1)</script>' } }] })),
    (e) => e.code === 'invalid' && /<|>/.test(e.message),
  );
  await assert.rejects(ctx.service.createPage(CO_A, HUMAN, page({ sections: [{ kind: 'iframe', props: {} }] })), (e) => e.code === 'invalid');
  await assert.rejects(
    ctx.service.createPage(CO_A, HUMAN, page({ sections: [{ kind: 'text', props: { nested: { a: 1 } } }] })),
    (e) => e.code === 'invalid',
  );
  await assert.rejects(
    ctx.service.createPage(CO_A, HUMAN, page({ sections: [{ kind: 'text', props: { ['__proto__']: 'x' } }] })),
    (e) => e.code === 'invalid',
  );
});

test('assertSections: an empty or missing list is fine, an oversized list is not', () => {
  assert.deepEqual(assertSections(undefined), []);
  assert.throws(() => assertSections(new Array(51).fill({ kind: 'text', props: {} })), MarketingError);
});

test('campaign and chatbot references must exist in the same company', async () => {
  const ctx = build();
  ctx.refs.seed(CO_A, 'camp-1');
  ctx.refs.seed(CO_A, 'bot-1');

  const ok = await ctx.service.createPage(CO_A, HUMAN, page({ campaignId: 'camp-1', chatbotId: 'bot-1' }));
  assert.equal(ok.campaignId, 'camp-1');
  assert.equal(ok.chatbotId, 'bot-1');

  await assert.rejects(ctx.service.createPage(CO_A, HUMAN, page({ slug: 'x1', campaignId: 'camp-404' })), (e) => e.code === 'not_found');
  await assert.rejects(ctx.service.createPage(CO_A, HUMAN, page({ slug: 'x2', chatbotId: 'bot-404' })), (e) => e.code === 'not_found');
  // camp-1 exists in company A only.
  await assert.rejects(ctx.service.createPage(CO_B, HUMAN, page({ slug: 'x3', campaignId: 'camp-1' })), (e) => e.code === 'not_found');
});

test('draft editing: an agent may edit a draft, and it cannot change the slug', async () => {
  const ctx = build();
  const p = await ctx.service.createPage(CO_A, AGENT, page({ sections: hero }));
  const edited = await ctx.service.updatePage(CO_A, AGENT, p.id, { title: 'Spring offer (v2)' });
  assert.equal(edited.title, 'Spring offer (v2)');
  assert.equal(edited.slug, 'spring-offer');
  assert.equal(edited.sections.length, 1);
});

test('publish: only a human can publish, and only a draft', async () => {
  const ctx = build();
  const p = await ctx.service.createPage(CO_A, AGENT, page());

  await assert.rejects(ctx.service.publishPage(CO_A, AGENT, p.id), (e) => e.code === 'forbidden');
  const live = await ctx.service.publishPage(CO_A, HUMAN, p.id);
  assert.equal(live.status, 'published');
  assert.ok(live.publishedAt instanceof Date);
  await assert.rejects(ctx.service.publishPage(CO_A, HUMAN, p.id), (e) => e.code === 'conflict');
});

test('a published page is read-only; archiving is human-only', async () => {
  const ctx = build();
  const p = await ctx.service.createPage(CO_A, HUMAN, page());
  await ctx.service.publishPage(CO_A, HUMAN, p.id);

  await assert.rejects(ctx.service.updatePage(CO_A, HUMAN, p.id, { title: 'nope' }), (e) => e.code === 'conflict');
  await assert.rejects(ctx.service.archivePage(CO_A, AGENT, p.id), (e) => e.code === 'forbidden');
  assert.equal((await ctx.service.archivePage(CO_A, HUMAN, p.id)).status, 'archived');
});

test('listPages filters by status and campaign, within the company only', async () => {
  const ctx = build();
  ctx.refs.seed(CO_A, 'camp-1');
  const a = await ctx.service.createPage(CO_A, HUMAN, page({ campaignId: 'camp-1' }));
  await ctx.service.createPage(CO_A, HUMAN, page({ slug: 'other' }));
  await ctx.service.publishPage(CO_A, HUMAN, a.id);

  assert.equal((await ctx.service.listPages(CO_A, { status: 'published' })).length, 1);
  assert.equal((await ctx.service.listPages(CO_A, { campaignId: 'camp-1' })).length, 1);
  assert.deepEqual(await ctx.service.listPages(CO_B), []);
});

// --- content ---------------------------------------------------------------

test('content: an agent drafts, a human approves, and only then can it be published', async () => {
  const ctx = build();
  const item = await ctx.service.createContent(CO_A, AGENT, { kind: 'blog_post', title: 'Bond cleaning', body: 'Markdown body.' });
  assert.equal(item.status, 'draft');

  await assert.rejects(ctx.service.publishContent(CO_A, HUMAN, item.id), (e) => e.code === 'conflict');
  await assert.rejects(ctx.service.approveContent(CO_A, AGENT, item.id), (e) => e.code === 'forbidden');
  await ctx.service.approveContent(CO_A, HUMAN, item.id);
  await assert.rejects(ctx.service.publishContent(CO_A, AGENT, item.id), (e) => e.code === 'forbidden');
  const live = await ctx.service.publishContent(CO_A, HUMAN, item.id);
  assert.equal(live.status, 'published');
});

test('content: an unknown kind, a blank body, or an unknown campaign are refused', async () => {
  const ctx = build();
  await assert.rejects(ctx.service.createContent(CO_A, HUMAN, { kind: 'tweet', title: 't', body: 'b' }), (e) => e.code === 'invalid');
  await assert.rejects(ctx.service.createContent(CO_A, HUMAN, { kind: 'ad_copy', title: 't', body: '  ' }), (e) => e.code === 'invalid');
  await assert.rejects(
    ctx.service.createContent(CO_A, HUMAN, { kind: 'ad_copy', title: 't', body: 'b', campaignId: 'camp-404' }),
    (e) => e.code === 'not_found',
  );
});

test('content: an approved item cannot be edited, but a draft can', async () => {
  const ctx = build();
  const item = await ctx.service.createContent(CO_A, AGENT, { kind: 'social_post', title: 't', body: 'v1' });
  const edited = await ctx.service.updateContent(CO_A, AGENT, item.id, { body: 'v2' });
  assert.equal(edited.body, 'v2');
  await ctx.service.approveContent(CO_A, HUMAN, item.id);
  await assert.rejects(ctx.service.updateContent(CO_A, HUMAN, item.id, { body: 'v3' }), (e) => e.code === 'conflict');
});

test('content: campaign link is validated, and listContent filters by kind and status', async () => {
  const ctx = build();
  ctx.refs.seed(CO_A, 'camp-1');
  await ctx.service.createContent(CO_A, HUMAN, { kind: 'email_copy', title: 'a', body: 'b', campaignId: 'camp-1' });
  await ctx.service.createContent(CO_A, HUMAN, { kind: 'ad_copy', title: 'c', body: 'd' });

  assert.equal((await ctx.service.listContent(CO_A, { kind: 'email_copy' })).length, 1);
  assert.equal((await ctx.service.listContent(CO_A, { campaignId: 'camp-1' })).length, 1);
  assert.equal((await ctx.service.listContent(CO_A, { status: 'draft' })).length, 2);
  assert.deepEqual(await ctx.service.listContent(CO_B), []);
});

// --- scope and the placeholder ---------------------------------------------

test('scope: a page or content item is invisible to another company', async () => {
  const ctx = build();
  const p = await ctx.service.createPage(CO_A, HUMAN, page());
  const c = await ctx.service.createContent(CO_A, HUMAN, { kind: 'blog_post', title: 't', body: 'b' });

  await assert.rejects(ctx.service.getPage(CO_B, p.id), (e) => e.code === 'not_found');
  await assert.rejects(ctx.service.publishPage(CO_B, HUMAN, p.id), (e) => e.code === 'not_found');
  await assert.rejects(ctx.service.getContent(CO_B, c.id), (e) => e.code === 'not_found');
  await assert.rejects(ctx.service.approveContent(CO_B, HUMAN, c.id), (e) => e.code === 'not_found');
});

test('scope: a missing or blank companyId fails closed', async () => {
  const ctx = build();
  await assert.rejects(ctx.service.createPage('', HUMAN, page()), /Company scope required/);
  await assert.rejects(ctx.service.listContent('  '), /Company scope required/);
});

test('drizzle placeholder: every method throws until the migration is promoted', async () => {
  const { createDrizzleMarketingStore } = await import('../../server/modules/marketing/index.ts');
  const store = createDrizzleMarketingStore();
  await assert.rejects(store.findPage(CO_A, 'x'), /DRAFT_marketing\.sql/);
  await assert.rejects(store.listContent(CO_A, {}), /DRAFT_marketing\.sql/);
});

test('simultaneous same-tenant slug inserts surface a stable conflict when PostgreSQL enforces the unique key',async()=>{
 const duplicate=Object.assign(new Error('duplicate key'),{code:'23505',constraint:'landing_pages_company_slug_uidx'});
 const store={findPageBySlug:async()=>null,insertPage:async()=>{throw duplicate;}};
 const refs={campaignExists:async()=>true,chatbotExists:async()=>true};
 const service=createMarketingService({store,campaigns:refs,chatbots:refs});
 await assert.rejects(service.createPage(CO_A,HUMAN,{slug:'race-safe',title:'Offer'}),e=>e instanceof MarketingError&&e.code==='conflict');
});
test('non-slug database unique constraints are not mistakenly labeled a slug conflict',async()=>{
 const duplicate=Object.assign(new Error('other constraint'),{code:'23505',constraint:'content_items_pkey'});
 const store={findPageBySlug:async()=>null,insertPage:async()=>{throw duplicate;}};
 const refs={campaignExists:async()=>true,chatbotExists:async()=>true};
 await assert.rejects(createMarketingService({store,campaigns:refs,chatbots:refs}).createPage(CO_A,HUMAN,{slug:'not-duplicate',title:'Offer'}),e=>e===duplicate);
});

test('failed concurrent publish never returns stale page as a success',async()=>{
 const ctx=build();const p=await ctx.service.createPage(CO_A,HUMAN,page());
 const original=ctx.store.updatePage.bind(ctx.store);ctx.store.updatePage=async()=>null;
 await assert.rejects(ctx.service.publishPage(CO_A,HUMAN,p.id),e=>e instanceof MarketingError&&e.code==='conflict');
 ctx.store.updatePage=original;
});
test('failed concurrent approve never returns stale content as a success',async()=>{
 const ctx=build();const item=await ctx.service.createContent(CO_A,HUMAN,{kind:'blog_post',title:'Story',body:'Body'});
 const original=ctx.store.updateContent.bind(ctx.store);ctx.store.updateContent=async()=>null;
 await assert.rejects(ctx.service.approveContent(CO_A,HUMAN,item.id),e=>e instanceof MarketingError&&e.code==='conflict');
 ctx.store.updateContent=original;
});

test('production service requires explicit database readiness before use',async()=>{
 const {createVerifiedMarketingService}=await import('../../server/modules/marketing/production-service.ts');
 const pool={connect:async()=>{throw new Error('must not connect while schema is unverified');}};
 const campaign={campaignExists:async()=>true},chatbot={chatbotExists:async()=>true};
 const schemaProbe={query:async()=>({rows:[]})};
 await assert.rejects(createVerifiedMarketingService({pool,campaigns:campaign,chatbots:chatbot,schemaProbe}),/database security not ready/);
});
