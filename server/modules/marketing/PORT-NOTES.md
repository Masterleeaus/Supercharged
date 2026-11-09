# Marketing port notes

New module for Desk comms mode. Not mounted. No migration run.

## Files

| File | What it is |
| --- | --- |
| `types.ts` | Landing page (with sections), content item. Campaign and chatbot appear as references only. |
| `ports.ts` | `MarketingStore`, `CampaignRefs`, `ChatbotRefs`. |
| `marketing-service.ts` | Pure service: drafts, human-only publish, reference checks, HTML guard. |
| `memory-adapter.ts` | `InMemoryMarketingStore`, `InMemoryRefs` (seeded fake for both reference ports). |
| `drizzle-adapter.ts` | `createDrizzleMarketingStore()`. Throws until the DRAFT migration is promoted. |
| `index.ts` | Exports. Not mounted. |
| `../../../migrations/DRAFT_marketing.sql` | Draft tables. Not run. |
| `../../../tests/modules/marketing.test.mjs` | 17 `node:test` cases. |

## Reused

| Existing code | How it is used |
| --- | --- |
| `server/modules/chatbot/` | Not duplicated. A landing page stores `chatbotId` only. `ChatbotRefs` can be satisfied by `createDrizzleChatbotStorage().findChatbot(companyId, id) !== null` once that storage is wired. Chatbot config (welcome message, instructions, generative UI) stays in the chatbot module. |
| `server/modules/chatbot/chatbot-scope.ts` `requireCompanyId` | Company-scope guard. |
| `migrations/DRAFT_*.sql` | DRAFT conventions. |

## Not reused

- Nothing in Desk stores landing pages or content records. `emailTemplates` in `shared/schema.ts` is for email, not pages. Not reused.

## Decisions for review

1. Publishing a page or content item is not a send, so it does not go through approvals. Human-only publish is the control instead.
2. Agents can create and edit drafts only. They cannot approve, publish or archive.
3. Section props are plain text, numbers, booleans or string lists. Angle brackets are refused, so no raw HTML reaches a page. The renderer still has to escape. If rich content is wanted, that is a separate decision.
4. Slugs are unique per company and fixed after creation.
5. A published page is read-only. Changes need a new draft (not built).
6. Content moves draft, approved, published. Only drafts are editable.

## Known gaps before real use

- No renderer, no public route, no hosting.
- Unique slug check is read-then-insert. The Drizzle version relies on the `(company_id, slug)` unique constraint.
- Campaign references are not checked for status. A page can link to a cancelled campaign.

## Pass 8: real SQL store, still not auto-mounted

`sql-store.ts`, `sql-row.ts` and `sql-patch.ts` now implement the existing nine-method MarketingStore contract with tenant-scoped PostgreSQL queries and fixed update-field allowlists. The implementation is exported as `createSqlMarketingStore({ pool })`; the prior fail-closed `createDrizzleMarketingStore()` is preserved for backward compatibility. The SQL store requires the archived DRAFT schema to be reviewed and promoted before it can run against a live database. No migration was applied. Unique page-slug races now map the PostgreSQL `landing_pages_company_slug_uidx` constraint to the existing domain conflict code.

Tests cover SQL shapes and tenant transaction behavior with recording pool fakes. Real RLS and concurrent DB tests remain required before enabling Marketing.

## Pass 9: draft RLS candidate and lifecycle conditions

The reviewed migration candidate is at `migrations/candidates/0017_marketing_tenant_rls.sql`, NOT in the production migration runner. It retains Marketing tables while adding forced tenant policies for `desk_app`. `scripts/check-marketing-migration.mjs` performs a non-invasive static preflight. SQL updates now condition on the prior publication status so stale concurrent writes cannot silently succeed. `MarketingService` surfaces a conflict if the store returns no changed record.

## Pass 10: PostgreSQL integration harness

A disposable PostgreSQL CI job exercises real tenant isolation, restricted role access, slug uniqueness and conditional lifecycle transitions. It does not alter the production migration list or enable Marketing on live servers.

## Pass 11: verified production composition

`createVerifiedMarketingService` is an opt-in async composition root. It requires a tenant Postgres pool, a separate schema inspection probe, real company-scoped campaign reference checks, and chatbot reference checks. It checks both Marketing tables for enforced and forced RLS and verifies the restricted database role before creating the SQL-backed service. It does not modify the production feature flag or run any migrations.

## Pass 12: policy combination hardening

The `policy-inspection.ts` helper validates the complete PostgreSQL policy expression and the exact desk_app role. The readiness gate now rejects permissive PUBLIC/desk_app overrides, allows only additional restrictive policies and explicitly fails closed on missing RLS metadata. CI exercises both simulated policy attacks and actual PostgreSQL pg_policies output.
