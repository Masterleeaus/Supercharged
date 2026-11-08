# Content admin: decisions

Section owner: analytics, canned responses, knowledge-base articles and contacts. Backend in
`server/modules/chatbot/content-admin/`, table in `server/modules/chatbot/db/content.ts`, draft SQL in
`server/modules/chatbot/db/migrations-draft/0002_content_admin.sql`, tests in `tests/modules/chatbot-content-admin.test.mjs`.

## Decisions for the owner to review

1. **Route prefix is `/api/chatbot/content/...`, mounted by the owner.** Nothing is mounted. Off by default behind `ENABLE_CHATBOT_CONTENT_ADMIN_ROUTES`, which must be exactly `"true"`.
2. **New tables use Desk names** (`chatbot_canned_responses`, `chatbot_knowledge_base_articles`), not core's `ext_chatbot_*`. Every table has `company_id`, and every unique key includes it.
3. **Article chatbot links are a join table** with composite foreign keys on `(company_id, id)`. The router also refuses any chatbot id outside the company with 400, so a write never reaches the database.
4. **Roles.** Everyone with the read roles can read. Canned responses can be written by admin, manager and agent. Articles are written by admin and manager. Analytics is read by admin and manager.
5. **Limits** (my choice, core has none): title 255, article description 1000, canned reply 10000, article content 50000, 50 chatbot links per article.
6. **Cross-company rows answer 404,** the same as a missing row. Delete is company-scoped, so another company's delete removes nothing.
7. **Analytics chart "agent replies" plots the `messages` metric.** `ANALYTICS_METRICS` has no agent-reply metric. Change request 2 below.
8. **Top agents shows a pending state.** No per-agent metric exists yet.
9. **Analytics and contacts answer 501 until their ports are injected,** and the screens show a pending state for 501. The analytics range is UTC days, at most 366 days.
10. **Contacts are read only,** served from an injected `ContactReader`. The adapter over the customers slice is not written yet. Contact detail opens in a side panel, so no new route is needed.
11. **Screens take the chatbot list as a prop** (`KnowledgeBasePage chatbots=...`) and are not added to `App.tsx` or the sidebar. The owner wires them.
12. **Drizzle storage is written but not connected** to any database. The migration draft is unapplied.

## Change requests against `contracts/`

- `contracts/flags.ts`: add `CONTENT_ADMIN_ROUTES_ENABLED: "ENABLE_CHATBOT_CONTENT_ADMIN_ROUTES"` to `CONTRACT_FLAGS`. The router reads the raw name through `readFlag` for now.
- `contracts/runtime.ts`: add `"agent_replies"` to `ANALYTICS_METRICS`, so the chart does not use `messages` as a stand-in.
- `contracts/knowledge.ts`: the knowledge agent needs to read articles, and `KnowledgeStorage` has no article method. Add a read port, or a `listArticles(companyId, chatbotId)` method, to it. The article table stays owned by this module.

## Gap pass (2026-11-09): contacts adapter, article port, mounted endpoints

Tests: `tests/modules/chatbot-ops-content-admin.test.mjs`, 16 of 16 pass (shared with ops). Scoped strict type check
(`/home/claude/integration-scratch/ops-content-tc`): 0 errors. Client screens were not type checked (no narrow client
config here).

1. **Contacts adapter over the customers slice.** `content-admin/contacts-adapter.ts` wraps the public `listCustomers` and
   `findCustomer` of the customers storage (the Drizzle adapter implements them with `company_id` filters). It returns only
   view fields. IP address, session id, payload and communication preferences never leave the adapter. There is no cap on
   the list size yet. Paging is an open question for the owner.
2. **Article read port for the knowledge agent.** `content-admin/article-read-port.ts` exposes
   `listForChatbot(companyId, chatbotId)`. It returns the company's articles linked to that chatbot that have content,
   featured first. Drafts with no content are left out.
3. **Pending state means "not mounted".** `isPending` now also covers a 404 that is the router's own `{ error: "Not found" }`
   or has no JSON error (Express default). A row-level 404 such as "Article not found" stays a real error.
4. **Knowledge page loads its chatbot list itself** from the mounted `GET /api/chatbot/chatbots` when no `chatbots` prop is
   passed. The prop still works.
5. **Canned responses page** shows the pending state when its routes are not mounted, as the other screens do.
6. **Still not mounted.** `/api/chatbot/content/*` is not mounted anywhere. The owner mounts it, behind
   `ENABLE_CHATBOT_CONTENT_ADMIN_ROUTES="true"`.

Change requests against `contracts/` (not edited here):
- `contracts/knowledge.ts`: the knowledge agent needs article reads. Proposed shape:
  `listForChatbot(companyId: string, chatbotId: string): Promise<ChatbotArticle[]>`, where `ChatbotArticle` is
  `{ id, title, description, content, isFeatured, updatedAt }`. The implementation is `ArticleReadPort` in
  `server/modules/chatbot/content-admin/article-read-port.ts`. Still open from the first pass.
- `contracts/runtime.ts`: add `"agent_replies"` to `ANALYTICS_METRICS`, so the chart stops using `messages` as a stand-in.
  Still open from the first pass.
