# Tenant-scoped Inbox storage (Pass 14)

The numbered Inbox schema `migrations/0010a_inbox.sql` already exists, but the original `createDrizzleInboxStore` CRUD methods are still intentionally fail-closed placeholders.

`createSqlInboxStore(pool)` implements all 15 concrete InboxStore operations through PostgreSQL parameter binding, company predicates and transaction-local tenancy. The store's advisory lock serializes one inbound contact across workers and its pinned connection is reused by nested store operations through `lockedInboxClient()`, so a busy pool cannot deadlock on a second checkout.

This implementation is **not mounted automatically**. The numbered Inbox tables presently lack an independently verified RLS policy, so Pass 14 is storage foundation only. Existing send-approval transaction semantics remain in `sqlInboxWriteTx`. Do not activate Inbox until its RLS, role permissions, approval port and route construction have been verified against actual PostgreSQL.

## Pass 15: PostgreSQL RLS candidate

The SQL store has a real PostgreSQL integration gate using a disposable database, original numbered Inbox DDL, and a restricted-role RLS candidate for all four tenant tables. This is a proof of isolation and transaction behavior on CI; production Inbox remains disabled pending reviewed RLS deployment and approval wiring.
