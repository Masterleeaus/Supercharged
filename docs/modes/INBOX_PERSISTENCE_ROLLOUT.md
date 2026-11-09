# Inbox persistent storage rollout

Pass 14 implements `createSqlInboxStore` for the existing numbered `0010a_inbox.sql` tables, rather than recreating the schema. Every store query has a company predicate and a transaction-local tenant setting.

The original Drizzle placeholder remains untouched as the compatibility default. Production Inbox is **not** mounted or enabled by this pass. Next gates are a reviewable, restricted-role RLS migration covering all Inbox tables, integration tests against disposable PostgreSQL, and a durable approvals port and transaction runner. No provider sends or external webhook delivery is enabled.

The advisory lock must hold the same pinned transaction for inbound participant lookup, thread linking, message insertion, and external ID dedupe, otherwise concurrent worker instances can race or exhaust a small connection pool.

## Pass 15 integration gate

The `inbox-postgres` GitHub Actions job runs the original `0010a_inbox.sql` followed by a separately reviewed tenant-RLS candidate on a disposable PostgreSQL 16 instance. It verifies actual table behavior, including cross-tenant blocking, composite-FK guarantees and advisory-lock rollback. No automatic migration or feature flag is altered by this job.

## Pass 16: activation gates

Pass 15's disposable PostgreSQL suite passed. Pass 16 adds a read-only live-schema readiness verifier plus an explicit SQL Inbox service constructor. The constructor requires approval and atomic transaction ports, but neither enables provider transport nor changes `COMMS_INBOX_ENABLED`. Before enabling routes, configure approval transactions per authenticated company and verify actual deployment role membership and audit events.
