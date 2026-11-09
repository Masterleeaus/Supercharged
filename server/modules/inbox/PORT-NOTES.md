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

## Pass 14: durable PostgreSQL InboxStore

The existing numbered `0010a_inbox.sql` schema is now supported by the opt-in `createSqlInboxStore(pool)` implementation. All 15 store methods use scoped SQL and parameterized predicates; advisory-locked inbound ingestion reuses its pinned tenant client. The earlier Drizzle placeholder remains unchanged for compatibility and the default production mount stays disabled. Tenant RLS and approval infrastructure must be validated before activation.

## Pass 15: real PostgreSQL RLS verification

A separate review-only candidate at `migrations/candidates/0018_inbox_tenant_rls.sql` enables and forces RLS on the four Inbox tables already created by `0010a_inbox.sql`. A dedicated disposable PostgreSQL CI job uses the actual SQL store to exercise tenant access, link FKs, external-ID uniqueness, inbound locks and rollback. Neither the original migration manifest nor Inbox activation is changed.

## Pass 16: fail-closed database readiness

The opt-in `createVerifiedInboxService` now validates the actual PostgreSQL catalog before constructing a persistent service, including restricted desk_app permissions and all four tables' ENABLE/FORCE RLS policies. A durable approval port and atomic transaction runner are mandatory. No automatic Inbox activation; request-specific approval transaction composition remains necessary before mounting multi-tenant routes.

## Pass 17: per-company approval execution

An InboxService shared by multiple authenticated companies no longer depends on a single fixed company transaction. Production composition derives a company-bound transaction runner from its PostgreSQL pool on each approved decision using `inboxTransactionsFor`. Existing `sqlInboxWriteTx` approval-claim and message-update code is reused; any wrong-company call throws and rolls back. No provider, approval policy, or routes are automatically enabled.

## Pass 18: canonical approval integration boundary

The `createInboxApprovalPort` adapter reuses the canonical ApprovalService for gate decisions, company-scoped reads and execution audit. It uses the conditional SQL claim from the existing Inbox transaction runner rather than passing a partial row into ApprovalService.markExecuted. Production construction can now accept `approvalService` directly, or an explicit approved custom port for existing integration tests; specifying both is an error. No routes or providers are enabled.

## Pass 19: verified production Inbox route composition

When explicitly enabled, the main verified comms registrar now composes Inbox with original SQL storage, the verified schema and canonical ApprovalService connected through the injected tenant pool. Both enabled modules verify before either route mounts. Defaults are unchanged and production provider sends remain unimplemented.

## Pass 20: durable outbound outbox (no provider enabled)

A review-only `0019_inbox_outbox.sql` candidate adds a tenant-RLS protected outbox table linked to the existing Inbox message. The new `createSqlOutbox` handles deduplicated queue enrollment, worker leases with SKIP LOCKED, safe acknowledgments and retry/dead-letter transitions. `createOutboxDispatcher` requires an explicitly injected provider implementing stable idempotency keys. No default provider, background scheduler, migrations or outbound sending are enabled.

## Pass 21: signed receipt callback boundary

A generic gateway HMAC verifier authenticates exact raw bytes with timestamp expiry and constant-time comparison. Trusted integration IDs resolve company/provider/secret on the server. Receipt persistence accepts only provider IDs already acknowledged by the tenant's outbox and records each (company,provider,eventId) once. A receipt router factory is provided but not mounted; callback format is for a controlled gateway and MUST NOT be treated as the native signature protocol of arbitrary third-party providers. No provider credentials, live sending, production migration or webhook registration is enabled.
