# Migration inventory (issue #197)

Date: 2026-11-15. Inventory only. No migration, schema column, runner entry or test was changed.

## Scope

Code-only part of #197: list every migration, check it against the runner, and name what is blocked. Live database checks are not done here.

## Result

- `migrations/` holds 22 `.sql` files: `0000_damp_spectrum.sql` (base) plus 21 numbered files.
- `migrations/meta/_journal.json` lists the same 22 files, in the same order. No file is missing from the journal and no journal entry is missing from disk.
- `scripts/run-safe-migration.mjs` lists 21 files. It does not list the base `0000_damp_spectrum.sql`, which is expected.
- Numbers are not unique. `0010` has three variants (`0010a_inbox`, `0010b_approvals`, `0010c_chatbot`) and `008`/`009` use three digits. Order is set by the journal and the runner list, not by the number alone.
- `migrations/candidates/` holds 5 files numbered `0017` to `0021`. They are not in the journal or the runner. Their numbers collide with promoted `0017` to `0019` on `main`. They need renumbering or a decision before promotion.
- `migrations/archive/` holds 24 `DRAFT_*.sql` files and a README. They are not run. Some tests read them.
- `0018_central_sso_company_links.sql` is operator-only. Open PR #305 (not on `main` when this was written) skips it by default.

## Promoted migrations (runner order)

| Order | File | Note |
|---|---|---|
| base | 0000_damp_spectrum.sql | Not in runner list; base schema |
| 1 | 0001_add_missing_columns.sql | required |
| 2 | 0002_add_google_sheets_credentials.sql | required |
| 3 | 0003_campaign_contact_retry.sql | required |
| 4 | 0004_add_missing_tables.sql | required |
| 5 | 0005_add_missing_agent_messaging_columns.sql | required |
| 6 | 0006_add_default_campaign_type.sql | required |
| 7 | 0007_add_external_fonoster_phone_id.sql | required |
| 8 | 008_add_ve_session_id_and_voice_engine_tables.sql | three-digit prefix |
| 9 | 009_fix_ve_session_id_and_all_missing_columns.sql | three-digit prefix |
| 10 | 0010_add_yookassa_columns.sql | YooKassa columns (see #293, which removes the integration) |
| 11 | 0010a_inbox.sql | letter variant |
| 12 | 0011_inbox_channels_and_providers.sql | |
| 13 | 0010b_approvals.sql | letter variant, runs after 0011 |
| 14 | 0013_approvals_revoked_status.sql | |
| 15 | 0010c_chatbot.sql | letter variant |
| 16 | 0014_workforce_tool_tables.sql | |
| 17 | 0015_company_quiet_hours.sql | |
| 18 | 0016_chatbot_reminder_pipeline.sql | |
| 19 | 0017_user_company_memberships.sql | issue #130 |
| 20 | 0018_central_sso_company_links.sql | operator-only (open PR #305) |
| 21 | 0019_central_sso_pending_logins.sql | |

## Blocked (live environment, not done here)

- Fresh bootstrap of a native PostgreSQL database from `main`, and startup readiness. Needs a database.
- Confirming the applied migration set and checksums on staging or garonhome.local. Needs access.
- Confirming that the `desk_app` role exists before tenant RLS policies take effect (see PR #306).
- Central OIDC, service credentials, signed linking, entitlements, flags and outbox checks. Needs Central.
- Two-tenant Sorted-to-Supercharged and Central-to-Supercharged end-to-end runs. Needs staging.
- Agent and worker audit for cross-tenant access. Needs a running system to test.

## Open decisions for the owner

- Renumber the five `migrations/candidates/` files to unused numbers after `0019`, or keep the current numbers and record the order. Not decided here.
- Whether to keep the three-digit `008`/`009` and the letter variants, or rename them in a new migration. Renaming an applied file is not allowed, so the current names stay.
