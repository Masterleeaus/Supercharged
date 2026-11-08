# Inbox port notes

New module for Desk comms mode. Not mounted. No migration run.

## Files

| File | What it is |
| --- | --- |
| `types.ts` | Channel, thread, participant, message, assignee, actor. Every entity has `companyId`. |
| `ports.ts` | `InboxStore` (persistence), `ApprovalPort` (structural approvals subset). |
| `inbox-service.ts` | Pure service: inbound dedupe, assignment, drafts, approval-bound send. |
| `memory-adapter.ts` | `InMemoryInboxStore`, `InMemoryApprovalPort` (fake gate for tests). |
| `drizzle-adapter.ts` | `createDrizzleInboxStore()`. Every method throws until the DRAFT migration is promoted. |
| `index.ts` | Exports. Not imported by `routes.ts` or `index.ts`. |
| `../../../migrations/DRAFT_inbox.sql` | Draft tables. Not run. |
| `../../../tests/modules/inbox.test.mjs` | 32 `node:test` cases, all passing in the 2026-11-08 run. |

## Reused

| Existing code | How it is used |
| --- | --- |
| `server/modules/approvals/approval-service.ts` `gateAction`, `getApproval`, `markExecuted` | Through `ApprovalPort`, a structural subset. `ApprovalService` satisfies it. approvals/index.ts is not imported (it pulls Express and auth). |
| `server/modules/approvals/types.ts` decision vocabulary | Gate result `status` values. |
| `server/modules/chatbot/chatbot-scope.ts` `requireCompanyId` | Company-scope guard, so it is not copied. |
| `server/modules/booking-agent/` | Layout and flow: ports, in-memory adapters, the rule that only an approved gate result releases the action. Code not copied. |
| `migrations/DRAFT_approvals.sql`, `DRAFT_chatbot.sql` | DRAFT file conventions (idempotent, company_id, composite FKs). |

## Not reused

- `shared/schema.ts` has no conversation or message table to reuse. `chatbot_conversations` covers web chat only, so inbox uses its own model.
- No audit events are written here. `approvals` already audits gate decisions. Thread and message changes are not audited yet.

## Decisions for review

1. Agents may draft only on threads assigned to them, and may send only their own drafts.
2. A human may send without the gate (`sendAsStaff`). The gate applies to agents only. This follows the brief literally. If humans should also be gated, change `sendAsStaff`.
3. Approval is bound to `messageId`, `threadId` and `bodySha256`. Drafts are immutable after `requestSend`.
4. `approvals.markExecuted` is called when a message is queued, not when the transport delivers it.
5. Agents may claim a thread for themselves only. Handing work to another agent or unassigning is human-only.
6. Channel address rules: email needs `@`. sms, whatsapp and phone need E.164. web_chat takes a short id.
7. A closed thread is not reused. The next inbound message opens a new thread. A snoozed thread reopens.

## Known gaps before real use

- `applyApprovalDecision` marks the approval executed, then updates the message. Status as of 2026-11-08: the service now takes an optional `transactions` runner, and runs both writes in one transaction when Desk supplies it. Without it (the default), the two writes still run one after another. Desk must supply the runner before real use.
- Inbound dedupe: the unique index on `(company_id, channel, external_id)` is in `DRAFT_inbox.sql` (`inbox_messages_external_uidx`), and the Drizzle store takes a transaction-scoped advisory lock per company, channel and address. The retry-on-conflict path still needs a test before real use.
- No transport. Queued messages wait for a worker that is not in this module.
