SUPERSEDED: see SUPERSEDED.md

# A9: Audit log rows are lost on a failed flush, and user deletion erases audit rows

**Source:** Desk `merged3` `server/services/audit-log.ts` (`logAuditEvent` queue push `:122`; `flushAuditLogs` `:158-182`; the queue is spliced out before the insert at `:163`, and the catch at `:179-181` only logs). `server/routes/admin/users-routes.ts:351` deletes every audit row for the user.

## Finding
1. `flushAuditLogs` removes the batch from the queue before the insert. If the insert fails, the catch logs an error and the rows are gone. Nothing retries them and nothing records what was lost.
2. The admin user-delete cascade runs `db.delete(schema.auditLogs)` for the user. The audit trail for a deleted account is removed, which defeats the table's purpose.

## Fix
- New `services/audit-queue.mjs` with `createAuditBuffer`. It is database-free and testable.
  - Rows stay queued until an insert succeeds. A failed batch goes back to the front of the queue, in order, and is retried with exponential backoff (5s doubling, capped at 60s).
  - A row that fails 5 times in a row is reported through `onLoss` with reason `max_attempts`. Rows shed to keep the queue under 10,000 are reported with reason `queue_overflow`.
  - Nothing is dropped without a report. `stats()` shows written, lost and pending counts.
- `audit-log.ts` uses the buffer. Rows are already redacted before queueing. `reportLostAuditRows` writes any lost rows to `console.error` as JSON, so they can be replayed from the logs.
- `users-routes.ts:351` no longer deletes audit rows. It sets `deletedAt` on them, for rows where `deletedAt` is still null.
- `shared/schema.ts`: adds `deletedAt` to `auditLogs`. `migrations/DRAFT_audit_logs_soft_delete.sql` adds the column and an index. It is marked DRAFT and is not in the runner sequence.

## Patch
`fix.diff`, applies to `merged3` with `git apply`. It touches `audit-log.ts`, `users-routes.ts` and `schema.ts`, and adds `audit-queue.mjs` and the draft migration. It applies cleanly after `03-admin-team-permissions` in either order; the hunks are separate.

## Test
`test/audit-durability.test.mjs`. Run from the Desk root: `node --test tests/security/audit-durability.test.mjs`. No install needed.
- Before the patch: 0 of 8 pass. Five fail with `ERR_MODULE_NOT_FOUND` (buffer absent). Three source checks fail (splice still present, delete still present, no `deleted_at` column or draft).
- After the patch: 8 of 8 pass.

## Decisions for review
1. Retry limits are 5 attempts, 5s base, 60s cap, 10,000 rows. These are my choices, so please confirm them.
2. The user delete cascade is not transactional. The new `update` runs after earlier deletes. Apply the draft migration before this code is deployed. Otherwise the update fails and the user is left half-deleted, as with any failure partway through the cascade.
3. The migration is a draft and has not been run. The `users` foreign key on `audit_logs.user_id` is `ON DELETE SET NULL`, so a hard user delete still unlinks the rows. The marker is kept, but the link to the user is lost.

## Residual risk
Rows waiting in memory are lost if the process dies before a successful insert; the error-log replay is the only copy in that case.
