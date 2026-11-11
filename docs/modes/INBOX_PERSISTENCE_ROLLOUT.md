# Inbox persistent storage rollout

Pass 14 implements `createSqlInboxStore` for the existing numbered `0010a_inbox.sql` tables, rather than recreating the schema. Every store query has a company predicate and a transaction-local tenant setting.

The original Drizzle placeholder remains untouched as the compatibility default. Production Inbox is **not** mounted or enabled by this pass. Next gates are a reviewable, restricted-role RLS migration covering all Inbox tables, integration tests against disposable PostgreSQL, and a durable approvals port and transaction runner. No provider sends or external webhook delivery is enabled.

The advisory lock must hold the same pinned transaction for inbound participant lookup, thread linking, message insertion, and external ID dedupe, otherwise concurrent worker instances can race or exhaust a small connection pool.

## Pass 15 integration gate

The `inbox-postgres` GitHub Actions job runs the original `0010a_inbox.sql` followed by a separately reviewed tenant-RLS candidate on a disposable PostgreSQL 16 instance. It verifies actual table behavior, including cross-tenant blocking, composite-FK guarantees and advisory-lock rollback. No automatic migration or feature flag is altered by this job.

## Pass 16: activation gates

Pass 15's disposable PostgreSQL suite passed. Pass 16 adds a read-only live-schema readiness verifier plus an explicit SQL Inbox service constructor. The constructor requires approval and atomic transaction ports, but neither enables provider transport nor changes `COMMS_INBOX_ENABLED`. Before enabling routes, configure approval transactions per authenticated company and verify actual deployment role membership and audit events.

## Pass 17: approved-send transaction isolation

The existing Inbox SQL store and approval-write code are reused. The newly exported `inboxTransactionsFor(pool)` binds one transaction runner per request company; its whole callback uses one restricted PostgreSQL connection and rejects foreign company arguments. The production constructor now uses that factory automatically. This does not yet connect a production approval policy or provider dispatcher, so Inbox remains off.

## Pass 18: approval policy integration

Production Inbox composition can now reuse the canonical ApprovalService as `approvalService`, so Inbox no longer needs a separate approval engine. A claim takes place atomically through the existing per-company SQL runner. Before feature activation, verify the target approval schema, role grants, real approval audit pipeline and outbound provider delivery, and run complete authenticated HTTP tests. Flags remain unchanged.

## Pass 19: verified Inbox route mounting

The actual Workforce/Comms registrar no longer needs a manually injected Inbox service. When `COMMS_INBOX_ENABLED=true`, startup constructs the existing SQL-backed Inbox service and canonical approval engine only after the database security gate succeeds. With the flag off, no Inbox schema query is performed. The RLS candidate is not promoted and no provider transport is enabled.

## Pass 20: opt-in persistent delivery queue

An additional review-only outbox candidate supports unique queued message enrollment and tenant-bound worker leases. The disposable CI database applies this table after Inbox's existing schema and RLS, with real tests for duplicate enrollment, cross-company denial, token-protected acknowledgement and retry. The dispatcher has no provider configured or scheduler; production sending remains disabled until migration review, provider idempotency, signed callbacks and delivery reconciliation are complete.

## Pass 21: signed delivery callback evidence

A review-only `0020_inbox_delivery_receipts.sql` candidate records immutable provider acknowledgments for previously sent, tenant-owned outbox rows. Callback signatures use a generic internal HMAC over timestamp and raw request body. Integration ID resolution selects the company and signing secret; user-supplied tenant selectors are ignored. The optional Express router remains unmounted and requires an explicit provider guard. Disposable PostgreSQL checks verify event deduplication and foreign-tenant denial. Provider-native signature translators, actual signing credentials, and delivery reconciliation operations remain prerequisites to production activation.

## Pass 22: delivery confirmation projection

Adds a review-only tenant-RLS delivery-state table linked by composite company/outbox keys. The signed receipt insert and conditional state projection happen in the same PostgreSQL transaction. Duplicate and late events cannot demote confirmed delivery; the separate query service reads delivery by scoped message ID. The candidate strengthens outbox provider acknowledgment uniqueness and receipt foreign-key tenant isolation. This does not automatically deploy migrations or activate outbound providers.
