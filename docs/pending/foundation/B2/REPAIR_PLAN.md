# B2 repair plan: migration journal, runner, drizzle config

Status: PROPOSAL. Nothing in migrations/, scripts/ or the live journal has been changed. Nothing has been run against any database.

Update (2026-11-09): the runner now lists 008 and 009, and both files exist in `migrations/`. It also lists 0011 and 0013. So decision D-B2-4 below is settled in code, and the "file does not exist" rows are out of date. Decision D-B2-3 (`add_missing_columns.sql`) is still open: the file is unnumbered and the runner does not name it. The live journal was not checked for this update.

## What is on disk (verified by listing merged4/migrations)

| File | In journal | In runner (scripts/run-safe-migration.mjs) |
|---|---|---|
| 0000_damp_spectrum.sql | yes (idx 0) | no (base schema, not re-run) |
| 0001_add_missing_columns.sql | yes | yes |
| 0002_add_google_sheets_credentials.sql | yes | yes |
| 0003_campaign_contact_retry.sql | yes | yes |
| 0004_add_missing_tables.sql | yes | yes |
| 0005_add_missing_agent_messaging_columns.sql | yes | yes |
| 0006_add_default_campaign_type.sql | NO. Journal has `0006_cultured_purifiers` (idx 6), which has no file | yes |
| 0007_add_external_fonoster_phone_id.sql | NO | yes |
| 008_add_ve_session_id_and_voice_engine_tables.sql | n/a | listed, FILE DOES NOT EXIST (runner warns and skips) |
| 009_fix_ve_session_id_and_all_missing_columns.sql | n/a | listed, FILE DOES NOT EXIST (runner warns and skips) |
| 0010_add_yookassa_columns.sql | NO | yes |
| add_missing_columns.sql (unnumbered) | NO | no |
| DRAFT_*.sql (7 files) | NO | no (correct) |

Other facts:
- No `drizzle.config.ts` in merged4. README_FIRST.md says the supplied backup omitted root configs, so check the real repo before creating one.
- `migrations/meta/` holds only `0000_snapshot.json`. Its `sip_calls` has the 19 base columns, so `drizzle-kit generate` would diff against a stale snapshot and re-emit changes made since 0000.
- `scripts/db-push-non-interactive.mjs` mentions a `tablesFilter` in `drizzle.config.ts`, which suggests the real repo has one.
- `add_missing_columns.sql` runs its own BEGIN/COMMIT inside the runner's transaction. It also alters `ve_sessions`, which is created in no file in the repo (verified by grep). So it fails on a database that lacks that table.
- Migration `0000` uses plain `CREATE TABLE`. Running it through the runner against an existing database fails, so it must stay out of the runner list.

## Fixes, in order

1. **Read-only check by the owner (not run by me).** For each target database, record which journal rows exist in the drizzle migrations table (default schema `drizzle`, table `__drizzle_migrations`), and whether `ve_sessions` and `sip_calls.openai_call_id` exist. Result decides items 2 and 4.
2. **Journal (proposed file: `_journal.proposed.json`).** Rename idx 6 from `0006_cultured_purifiers` to `0006_add_default_campaign_type` and keep its `when`. drizzle stores a hash of the SQL and `created_at = when`, so a tag rename does not change what is recorded. Add idx 7 (`0007_add_external_fonoster_phone_id`) and idx 8 (`0010_add_yookassa_columns`).
   - The `when` values for idx 7 and 8 are PLACEHOLDERS. drizzle's migrator skips journal entries whose `when` is not later than the last applied row. They must be later than the newest `created_at` in each target database. This is unverified.
   - Keep `0000` in the journal (drizzle needs the baseline) but excluded from the runner.
3. **Runner.** Replace the hard-coded `MIGRATIONS` list (lines 52-63) with the journal, minus a baseline skip list:
   ```js
   const journal = JSON.parse(readFileSync(resolve(rootDir, 'migrations/meta/_journal.json'), 'utf8'));
   const BASELINE = new Set(['0000_damp_spectrum']);
   const MIGRATIONS = journal.entries
     .filter((e) => !BASELINE.has(e.tag))
     .map((e) => resolve(rootDir, 'migrations', `${e.tag}.sql`));
   ```
   Remove the 008 and 009 lines. Do not add DRAFT files. Missing files should fail hard, not warn.
4. **add_missing_columns.sql.** Decision D-B2-3 below. If adopted, rename to `0008_add_missing_columns_ve_leads.sql`, drop its BEGIN/COMMIT, and guard the `ve_sessions` ALTER with an existence check.
5. **drizzle.config.ts.** Template in `drizzle.config.proposed.ts`. Use it only if the real repo lacks one.

## What would be run (when approved, by the owner)
- Nothing from this folder is executed by me.
- Owner runs `npm run db:migrate` only against a non-production copy first, after items 1 to 3.

## Unverified
- Live journal state of each database, including whether a row for 0006_cultured_purifiers was ever written.
- Whether the real repo has a `drizzle.config.ts`.
- Contents of the missing 008 and 009 files. They may exist on another branch or in the original upstream repo.

## Decisions for review
- D-B2-1: keep or delete the `0006_cultured_purifiers` tag. Proposed: rename, keep `when`.
- D-B2-2: `when` values for 0007 and 0010 (placeholders).
- D-B2-3: fold `add_missing_columns.sql` into the sequence as 0008, or drop it. Its `ve_sessions` part needs the table to exist first.
- D-B2-4: whether 008 and 009 are recreated from the owner's copy or dropped from the runner.
