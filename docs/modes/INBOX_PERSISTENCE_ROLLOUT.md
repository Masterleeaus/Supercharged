# Inbox persistent storage rollout

Pass 14 implements `createSqlInboxStore` for the existing numbered `0010a_inbox.sql` tables, rather than recreating the schema. Every store query has a company predicate and a transaction-local tenant setting.

The original Drizzle placeholder remains untouched as the compatibility default. Production Inbox is **not** mounted or enabled by this pass. Next gates are a reviewable, restricted-role RLS migration covering all Inbox tables, integration tests against disposable PostgreSQL, and a durable approvals port and transaction runner. No provider sends or external webhook delivery is enabled.

The advisory lock must hold the same pinned transaction for inbound participant lookup, thread linking, message insertion, and external ID dedupe, otherwise concurrent worker instances can race or exhaust a small connection pool.
