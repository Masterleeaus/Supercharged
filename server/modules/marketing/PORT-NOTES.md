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
