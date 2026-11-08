# SUPERSEDED: A9 audit log durability patch

Date: 2026-11-03

This patch (`fix.diff`, `test/audit-durability.test.mjs`) is superseded. Do not apply it as-is.

Decided policy: when the audit buffer is full, drop the NEWEST events and keep the OLDEST. This is implemented in `server/services/audit-log.ts`.

The held patch uses the opposite policy (it drops the oldest rows). It also adds a separate `audit-queue.mjs`, a `max_attempts` loss path and `reportLostAuditRows`.

The patch's test expects `createAuditBuffer` and `reportLostAuditRows` in `server/services/audit-log.ts`. Those functions do not exist in the current `audit-log.ts`.
