# Retention, export, deletion, incident response and backup: proposal

**DRAFT FOR OWNER DECISION.** Nothing here is decided, implemented or tested. Numbers are proposals. Scope: workforce run and audit data (SuperchargedAt checklist section 11). Facts come from reading the pg-store, pg-budgets, DRAFT migration and DEPLOY_PACK files. No code or tests were run.

## 1. What data exists

| Data | Table or store | Current state |
|---|---|---|
| Runs | `workforce_runs` | Read and written by pg-store. Draft DDL, not applied. |
| Tool calls | `workforce_tool_calls` | Draft DDL only. No code under `server/` reads or writes it. |
| Tasks | `workforce_tasks` | Draft DDL only. No code reads or writes it. |
| Audit events | `workforce_audit_events` | Written and read by pg-store. Detail is redacted before storage. |
| Budget usage | `workforce_budget_usage` (daily counters per company) | Draft DDL. pg-budgets.ts updates it and deletes empty rows. |
| Agent memory | None | `agent-memory.ts` does not exist, and no memory store was found under `server/workforce/runtime/`. |

Company scoping is not yet enforced at the database. `DEPLOY_PACK.md` (section c) records that scoping is still open.

## 2. Proposed retention (proposal)

| Data | Proposed period | Reason | Open question |
|---|---|---|---|
| Runs, after they end | 365 days | Covers dispute and billing review over a year | Q1 |
| Tool calls and tasks | 180 days | High volume; audit keeps the decision trail | Q2 |
| Audit events | 7 years | Long review horizon; the app cannot prune them (section 4) | Q3 |
| Budget usage | 13 months of daily rows | Covers monthly reconciliation plus a year-on-year check | Q4 |
| Agent memory | Not proposed | No store exists yet | Q5 |

## 3. Export

Proposed: a company exports only its own runs, tool calls, tasks, audit events and budget usage. Formats: JSON for full detail, and CSV with one file per table. Every export query filters on the company_id of the authenticated caller, the rule pg-store already follows. Audit detail is redacted at write time, so exports carry no raw secrets. An export must refuse when the company is unknown. No export route was inspected, and none is assumed.

## 4. Deletion

- The application cannot update or delete audit rows. pg-store exposes no such call. `DRAFT_workforce_append_only.sql` adds triggers that block UPDATE, DELETE and TRUNCATE, but that file is not applied.
- The rule is weaker than it sounds. A database owner can drop the table or disable triggers, and the app role's INSERT and SELECT grants are created outside this pack.
- Budget rows are deleted by code when empty. That is normal housekeeping, not audit deletion.
- The owner must choose what happens to audit at the end of its period or when a company leaves:
  - A: keep audit unchanged for its full period, with no deletion before then.
  - B: anonymise personal fields (actor, data) through a separate, owner-run, logged procedure. This breaks the append-only rule for those rows.
  - C: keep audit in full under a stated legal basis, and delete only runs and tool calls on company removal.
- The drafts have no companies table and no foreign keys, so there is no defined cascade on company removal.

## 5. Backup and restore

Proposal:

- Daily full logical dump (pg_dump) of the production database, plus point-in-time recovery if the host supports it.
- Keep 30 daily and 12 monthly copies. Encrypt at rest and store off the DirectAdmin host.
- Monthly restore test into a scratch database. Compare row counts for each workforce table with the source, list and explain any gaps in audit `seq`, and confirm the append-only triggers are present.

Not done: no backup job exists in the reviewed code, and no restore has been tested. The test needs a scratch database, a dump copy, a restore runbook and an owner-held restore role.

## 6. Incident response (proposed sequence)

1. Detect and record the time and source. Contact: [MONITORING CONTACT].
2. Contain: stop affected runs and block the affected company's tool access, by hand or with runtime controls once their behaviour is confirmed. Contact: [OWNER CONTACT].
3. Preserve: snapshot affected run and audit rows before any change. Delete nothing.
4. Assess: identify the company_id values, runs, tools and data touched.
5. Notify affected companies and any regulator, on counsel's advice. Contacts: [LEGAL CONTACT], [PRIVACY CONTACT].
6. Recover: restore from backup only after a test restore in scratch. Contact: [HOSTING CONTACT].
7. Review: written post-incident review within [N] days.

## 7. Open questions (none decided)

- **Q1. Run retention.** Options: 90 days; 365 days (proposed); 7 years.
- **Q2. Tool calls and tasks.** Options: keep 180 days (proposed); drop the tables and rely on audit; keep indefinitely.
- **Q3. Audit retention.** Options: 7 years (proposed); 3 years; match each company's contract.
- **Q4. Budget usage.** Options: 13 months (proposed); 90 days; keep indefinitely.
- **Q5. Agent memory.** Options: scope per run; per company; per agent. Decide before the store is built.
- **Q6. Export format.** Options: JSON and CSV (proposed); JSON only; CSV only.
- **Q7. Logging exports.** Options: add an audit kind (changes AUDIT_KINDS and the table CHECK); log to a separate table; do not log.
- **Q8. Audit at company removal.** Options: keep whole (4C); anonymise (4B); owner-run purge.
- **Q9. Backup retention.** Options: 30 daily and 12 monthly (proposed); 14 daily; other.
- **Q10. Backup storage and key holder.** Options: separate cloud storage with an owner-held key; a second hosting account; other.
- **Q11. Notification duties and clock.** Options: per counsel's advice; per customer contract; internal only.
- **Q12. Incident lead.** Options: owner; named delegate; external responder.
