# Migration reconciliation: journal, SQL files, and runner

Scope: read-only review of `migrations/meta/_journal.json`, the SQL files in `migrations/`, and `scripts/run-safe-migration.mjs`. No migration was run, no database was contacted, and no journal, migration or checklist file was edited. `docs/pending/foundation/B2/REPAIR_PLAN.md` was read and not applied.

## 1. Inventory

### 1a. Files in `migrations/` (19 `.sql`, from `ls`)

| File | Size (bytes) |
|---|---|
| 0000_damp_spectrum.sql | 88007 |
| 0001_add_missing_columns.sql | 1968 |
| 0002_add_google_sheets_credentials.sql | 1041 |
| 0003_campaign_contact_retry.sql | 1415 |
| 0004_add_missing_tables.sql | 5405 |
| 0005_add_missing_agent_messaging_columns.sql | 1890 |
| 0006_add_default_campaign_type.sql | 503 |
| 0007_add_external_fonoster_phone_id.sql | 501 |
| 0010_add_yookassa_columns.sql | 978 |
| add_missing_columns.sql | 764 |
| DRAFT_action_ledger.sql | 2155 |
| DRAFT_approvals.sql | 2282 |
| DRAFT_audit_chain.sql | 801 |
| DRAFT_campaigns.sql | 5616 |
| DRAFT_chatbot.sql | 3423 |
| DRAFT_companies_foundation.sql | 13473 |
| DRAFT_company_scope.sql | 58558 |
| DRAFT_inbox.sql | 4382 |
| DRAFT_marketing.sql | 2562 |

Also present: `migrations/meta/0000_snapshot.json` (a drizzle snapshot, dated Apr 23) and `migrations/meta/_journal.json`.

### 1b. Entries in `migrations/meta/_journal.json` (read directly, version 7, dialect postgresql)

| idx | tag | when |
|---|---|---|
| 0 | 0000_damp_spectrum | 1769161470557 |
| 1 | 0001_add_missing_columns | 1769800000000 |
| 2 | 0002_add_google_sheets_credentials | 1770100000000 |
| 3 | 0003_campaign_contact_retry | 1770400000000 |
| 4 | 0004_add_missing_tables | 1771000000000 |
| 5 | 0005_add_missing_agent_messaging_columns | 1772000000000 |
| 6 | 0006_cultured_purifiers | 1785909278100 |

Seven entries. `when` values ascend with idx. Idx 0 to 5 use round-number timestamps; idx 6 uses a non-round one, which suggests it was written by a different tool or by hand.

## 2. Reconciliation

### 2a. Journal tags and their files

| Journal tag | Matching file | Status |
|---|---|---|
| 0000_damp_spectrum | 0000_damp_spectrum.sql | Matched |
| 0001_add_missing_columns | 0001_add_missing_columns.sql | Matched |
| 0002_add_google_sheets_credentials | 0002_add_google_sheets_credentials.sql | Matched |
| 0003_campaign_contact_retry | 0003_campaign_contact_retry.sql | Matched |
| 0004_add_missing_tables | 0004_add_missing_tables.sql | Matched |
| 0005_add_missing_agent_messaging_columns | 0005_add_missing_agent_messaging_columns.sql | Matched |
| 0006_cultured_purifiers | none | **Journal-only.** No file with this tag. The only 0006 file is `0006_add_default_campaign_type.sql`. |

Journal-only tags: **1** (`0006_cultured_purifiers`).

### 2b. SQL files and journal entries

| File | Journal entry | Status |
|---|---|---|
| 0000_damp_spectrum.sql | idx 0 | Matched |
| 0001 to 0005 | idx 1 to 5 | Matched |
| 0006_add_default_campaign_type.sql | none | **File-only.** Probably the file meant by idx 6. |
| 0007_add_external_fonoster_phone_id.sql | none | **File-only.** Unjournaled. |
| 0010_add_yookassa_columns.sql | none | **File-only.** Unjournaled. Number skips 0008 and 0009. |
| add_missing_columns.sql | none | **File-only.** Unnumbered, so it has no place in the sequence. |
| DRAFT_*.sql (9 files) | none | **File-only.** Drafts, not migrations. |

File-only files: **13** (0006_add_default_campaign_type, 0007, 0010, add_missing_columns, and 9 DRAFT files). Of these, 3 are numbered migrations that the runner executes but the journal does not record. Note: `REPAIR_PLAN.md` says there are 7 DRAFT files; there are 9.

### 2c. Ordering problems

1. Idx 6 is tagged `0006_cultured_purifiers`, but the file numbered 0006 is `0006_add_default_campaign_type`. The journal and disk disagree on the name of the sixth migration.
2. The sequence runs 0000 to 0007, then jumps to 0010. Nothing numbered 0008 or 0009 exists on disk or in the journal.
3. `add_missing_columns.sql` has no number and sorts after the others in a plain `ls`, but the runner does not use it.
4. The journal's `when` for idx 6 is later than anything else. If a `when` for 0007 or 0010 is added, it must be later than the newest `created_at` in each target database. This cannot be checked from the repo.

## 3. Runner: `scripts/run-safe-migration.mjs`

- **Does it read the journal?** No. It does not open `_journal.json`.
- **How it picks files:** a hard-coded `MIGRATIONS` array of 10 absolute paths (lines 52 to 63). It runs them in array order, which is numeric order. There is no directory glob and no pattern match.
- **Files it lists:** 0001, 0002, 0003, 0004, 0005, 0006_add_default_campaign_type, 0007, `008_add_ve_session_id_and_voice_engine_tables.sql`, `009_fix_ve_session_id_and_all_missing_columns.sql`, 0010.
- **Missed files:** 0000 (intentional, the base schema), `add_missing_columns.sql` (not listed), and all DRAFT files (correctly excluded).
- **Names that do not exist:** the two 008 and 009 entries use three-digit names with no leading zero. Neither file is on disk. The runner warns and skips them with `existsSync`, so the run continues and exits successfully. If the owner's copies are named `0008_...` and `0009_...`, the runner would still skip them, because the paths are written with the three-digit names.
- **Double-run risk:** the array has no duplicates, so one invocation runs each listed file once. The runner keeps no applied-migrations record. Each invocation re-runs every listed file, and only the idempotent `IF NOT EXISTS` guards prevent errors. Files that are not idempotent would fail or change data on a second run.
- **Stale comment:** the header (lines 4 to 6) lists only 0001 and 0002.

## 4. Repair plan summary (`docs/pending/foundation/B2/REPAIR_PLAN.md`, read only)

- Owner first checks, read-only, which rows exist in the live `__drizzle_migrations` table in each target database, and whether `ve_sessions` and `sip_calls.openai_call_id` exist.
- Rename journal idx 6 from `0006_cultured_purifiers` to `0006_add_default_campaign_type`, keep its `when`, and add idx 7 (`0007_add_external_fonoster_phone_id`) and idx 8 (`0010_add_yookassa_columns`) to a proposed `_journal.proposed.json`. The `when` values for 7 and 8 are placeholders.
- Replace the hard-coded runner list with one read from the journal, skipping `0000_damp_spectrum`, and remove the 008 and 009 lines. Missing files should fail hard, not warn.
- Decide whether `add_missing_columns.sql` becomes `0008_add_missing_columns_ve_leads.sql`, with its BEGIN/COMMIT removed and the `ve_sessions` ALTER guarded, or is dropped.
- Add `drizzle.config.ts` only if the real repo lacks one. `merged4` has none.

## 5. Decisions the owner needs to make before any migration runs

1. Which database rows exist? Check the live `__drizzle_migrations` table in each target database, including whether `0006_cultured_purifiers` was ever recorded there. This decides the other items.
2. Is the journal tag `0006_cultured_purifiers` kept, or renamed to match `0006_add_default_campaign_type.sql`? (D-B2-1)
3. Are `0007_add_external_fonoster_phone_id.sql` and `0010_add_yookassa_columns.sql` real migrations to be journaled, and what `when` values should they carry, later than each database's newest `created_at`? (D-B2-2)
4. Are `008_...` and `009_...` real? If so, where are their files (owner copy, another branch, upstream)? If not, remove them from the runner. Either way, decide the numbering, since the runner uses three digits. (D-B2-4)
5. Is `add_missing_columns.sql` folded into the sequence, and if so as 0008 with its `ve_sessions` dependency handled, or dropped? (D-B2-3)
6. Which of the 9 DRAFT files, if any, are promoted to numbered migrations, and in what order? Until then they stay out of the runner.
7. Should the runner read the journal, and should it fail on a missing file instead of warning?
8. Should the runner track applied migrations, given that it currently re-runs every listed file on every invocation?
9. Does the real repo have a `drizzle.config.ts`? `merged4` does not.
10. Is `migrations/meta/0000_snapshot.json` stale? `REPAIR_PLAN.md` says its `sip_calls` table has only the 19 base columns.
