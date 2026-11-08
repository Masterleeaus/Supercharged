# Backup plan (Desk workforce run and audit data)

Status: partly decided. Items marked DECIDED were decided by Jason on 2026-11-03. Everything else is PROPOSED or NOT DECIDED. Nothing here is built.

Known state: no backup job exists in the code reviewed, and no restore has been tested (see `docs/RETENTION_PROPOSAL.md`, section 5).

## 1. Decided by Jason (2026-11-03)

- DECIDED: Take a daily full logical dump with `pg_dump` of the production database that holds workforce run and audit data.
- DECIDED: Keep 14 daily copies. (`docs/RETENTION_PROPOSAL.md` Q9, option "14 daily".)
- DECIDED: Store the copies in a second hosting account, controlled by the owner. They are not kept on the same host as the production database. (`docs/RETENTION_PROPOSAL.md` Q10, option "a second hosting account".)

## 2. Not decided (Jason to choose)

- NOT DECIDED: Monthly copies. The proposal kept 12 monthly copies. The 14-daily decision does not mention them, so none are planned until Jason says so.
- NOT DECIDED: Encryption at rest. The proposal says encrypt. No key holder is chosen.
- NOT DECIDED: Point-in-time recovery, if the host supports it.
- NOT DECIDED: Who runs the daily job, and who holds the restore role.
- NOT DECIDED: Restore test cadence. The proposal says a monthly restore into a scratch database.
- NOT DECIDED: Access rules for the second hosting account.

## 3. Restore rules (proposed, not decided)

- Restore only after a test restore in a scratch database.
- Before any restore or change, snapshot the affected run and audit rows. Delete nothing.
- After a restore, compare row counts for each workforce table with the source. List and explain any gaps in audit `seq`.
- Confirm the append-only triggers are present. They come from `DRAFT_workforce_append_only.sql`, which is not applied, so a restored database may not have them.

## 4. Known gaps

- No backup job exists in the code reviewed.
- No restore has been tested.
- Backup copies hold run and audit data, so the second account needs access rules before the first copy is stored.

## 5. Sources

- Jason's decisions, 2026-11-03 (section 1).
- `docs/RETENTION_PROPOSAL.md`, sections 5 and 7 (Q9, Q10).
- `docs/SHADOW_WRITES_DESIGN.md` is not a backup source; it is listed only because the reconciliation check copy is discussed in `docs/AUTO_RECONCILIATION_DESIGN.md`.
