# Desk tenancy inventory

Status: classification for review. Schema columns (`shared/schema.ts`) and the draft `migrations/DRAFT_companies_foundation.sql` add nullable `company_id` and `companies`; nothing is applied and no route is changed.
Source: `shared/schema.ts`, 132 `pgTable` declarations (rows 1-83 as before, the `company_quiet_hours` table at row 19 created by `migrations/0015_company_quiet_hours.sql`, the three chatbot tables at rows 85-87, the five workforce tables at rows 88-92 (the membership table is row 20, added by migration 0017), and the 39 workforce tool tables at rows 94-132, created by `migrations/0014_workforce_tool_tables.sql`). The check is
`tests/infrastructure/tenancy-inventory.test.mjs`. Migration steps are in
`migrations/DRAFT_company_scope.sql`. The eight tenant tables from `DRAFT_chatbot.sql` and the workforce drafts are protected by row-level security in `migrations/DRAFT_company_scope_extension.sql`. A tenant table counts as covered if either draft protects it (decision 12).

## Coverage by draft

- Tenant tables (104): all covered. 55 by `DRAFT_company_scope.sql` (its backfill is blocked on decision D1), 8 by `DRAFT_company_scope_extension.sql`, 39 by `migrations/0014_workforce_tool_tables.sql`, 1 by `migrations/0015_company_quiet_hours.sql`, 1 by `migrations/0017_user_company_memberships.sql`. The 39 workforce tool tables are not in any archived draft. Their own migration creates each one with `company_id uuid NOT NULL REFERENCES companies(id)`, so they need no backfill and no STEP A-D work. The coverage test reads 0014 and 0015 for this. `company_quiet_hours` has `company_id` as its primary key, so it also needs no backfill. Row-level security for it is not in 0015; it is still open under the tenancy plan.
- Not covered by any draft, by class: the 11 ambiguous tables (`users`, `otp_verifications`, `synced_voices`, `phone_numbers`, `notifications`, `prompt_templates`, `audit_logs`, `payment_webhook_queue`, `plivo_phone_numbers`, `demo_sessions`, `phone_release_retry_queue`) and the 16 global tables. `companies` is the root.
- Open gap: `users.company_id` is the source for every backfill and its value mapping is still open (D1).

## Classes

- **tenant**: holds one company's data. Gets `company_id` (nullable first, then backfilled, then FK, then NOT NULL). The parent column shows the backfill source.
- **global**: platform catalogue, shared credential pool, or site config. No `company_id`.
- **ambiguous**: the owner cannot be decided from the schema. Not drafted until a decision is made.
- **root**: the tenant registry itself (`companies`). It is not company-owned, so it has no `company_id`.

## Counts

- tenant: 104
- global: 16
- ambiguous: 11
- root: 1 (companies)
- total: 132

## Table classification

| # | table | class | parent (backfill source) | notes |
|---|---|---|---|---|
| 1 | users | ambiguous | - | Tenant root. Holds free-text `company`, not an id. Decision D1. |
| 2 | otp_verifications | ambiguous | - | Pre-auth, keyed by email, no user_id. |
| 3 | refresh_tokens | tenant | users.id via user_id | Read during login before the tenant is set; keep on the plain pool. |
| 4 | eleven_labs_credentials | global | - | Platform API-key pool; no owner column. |
| 5 | synced_voices | ambiguous | - | credential_id is a pool row; public_owner_id has no FK. |
| 6 | agents | tenant | users.id via user_id | user_id NOT NULL -> users |
| 7 | knowledge_base | tenant | users.id via user_id | user_id NOT NULL -> users |
| 8 | incoming_agents | tenant | users.id via user_id | user_id NOT NULL -> users |
| 9 | phone_numbers | ambiguous | - | user_id NULL for system pool numbers. |
| 10 | incoming_connections | tenant | users.id via user_id | user_id NOT NULL -> users |
| 11 | campaigns | tenant | users.id via user_id | user_id NOT NULL -> users |
| 12 | contacts | tenant | campaigns.id via campaign_id | Child of campaigns. |
| 13 | calls | tenant | users.id via user_id, campaigns.id via campaign_id, incoming_connections.id via incoming_connection_id, website_widgets.id via widget_id | user_id nullable. Fallbacks: campaign, incoming connection, widget (widget_id has no FK). |
| 14 | credit_transactions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 15 | tools | tenant | users.id via user_id | user_id NOT NULL -> users |
| 16 | voices | tenant | users.id via user_id | user_id NOT NULL -> users |
| 17 | plans | global | - | Plan catalogue. |
| 18 | global_settings | global | - | Key/value platform configuration; updated_by only. |
| 19 | company_quiet_hours | tenant | companies.id via company_id | Migration 0015. New table, no backfill. company_id is the primary key; no FK (no applied companies table). |
| 20 | user_company_memberships | tenant | companies.id via company_id | Migration 0017 (issue #130). New table, no backfill from this file. Links users to companies (many-to-many). FK user_id to users.id; no FK to companies. |
| 21 | llm_models | global | - | Model catalogue. |
| 22 | supported_languages | global | - | Language catalogue. |
| 23 | credit_packages | global | - | Credit package catalogue. |
| 24 | user_subscriptions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 25 | phone_number_rentals | tenant | users.id via user_id | user_id NOT NULL -> users |
| 26 | usage_records | tenant | users.id via user_id | user_id NOT NULL -> users |
| 27 | webhooks | tenant | users.id via user_id | Legacy table (Drizzle legacyWebhooks). |
| 28 | webhook_deliveries | tenant | webhooks.id via webhook_id | Child of legacy webhooks. |
| 29 | notifications | ambiguous | - | user_id NULL for broadcast notifications. |
| 30 | email_templates | global | - | Platform email templates; no owner column. |
| 31 | prompt_templates | ambiguous | - | user_id NULL marks a system template. |
| 32 | agent_versions | tenant | agents.id via agent_id | Child of agents. |
| 33 | audit_logs | ambiguous | - | user_id nullable; platform-wide and tenant audit mixed. |
| 34 | platform_languages | global | - | Language catalogue. |
| 35 | twilio_countries | global | - | Country catalogue. |
| 36 | user_knowledge_storage_limits | tenant | users.id via user_id | user_id NOT NULL -> users |
| 37 | knowledge_chunks | tenant | users.id via user_id | Has user_id and knowledge_base_id; uses user_id. |
| 38 | knowledge_processing_queue | tenant | users.id via user_id | user_id NOT NULL -> users |
| 39 | flows | tenant | users.id via user_id | is_template rows may be platform-wide; confirm before backfill. |
| 40 | flow_executions | tenant | flows.id via flow_id | Child of flows. |
| 41 | flow_test_queue | tenant | users.id via user_id | user_id NOT NULL -> users |
| 42 | webhook_subscriptions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 43 | webhook_logs | tenant | webhook_subscriptions.id via webhook_id | Drizzle webhookDeliveryLogs. webhook_id nullable; NULL rows have no parent. |
| 44 | appointments | tenant | users.id via user_id | user_id NOT NULL -> users |
| 45 | appointment_settings | tenant | users.id via user_id | user_id NOT NULL -> users |
| 46 | forms | tenant | users.id via user_id | user_id NOT NULL -> users |
| 47 | form_fields | tenant | forms.id via form_id | Child of forms. |
| 48 | form_submissions | tenant | forms.id via form_id | Child of forms. |
| 49 | seo_settings | global | - | Site-wide SEO settings; updated_by only. |
| 50 | analytics_scripts | global | - | Site-wide script injection; updated_by only. |
| 51 | payment_transactions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 52 | refunds | tenant | users.id via user_id | user_id NOT NULL -> users |
| 53 | invoices | tenant | users.id via user_id | user_id NOT NULL -> users |
| 54 | payment_webhook_queue | ambiguous | - | user_id nullable; gateway events can arrive before the user is resolved. |
| 55 | email_notification_settings | global | - | Platform event config; updated_by only. |
| 56 | banned_words | global | - | Platform moderation list; created_by only. |
| 57 | content_violations | tenant | users.id via user_id | user_id NOT NULL -> users |
| 58 | openai_credentials | global | - | Platform API-key pool; no owner column. |
| 59 | plivo_credentials | global | - | Platform provider credentials; no owner column. |
| 60 | plivo_phone_numbers | ambiguous | - | user_id nullable; pool rows likely unowned, as in phone_numbers. |
| 61 | plivo_calls | tenant | users.id via user_id, campaigns.id via campaign_id, agents.id via agent_id | user_id nullable. Fallbacks: campaign, agent. |
| 62 | campaign_jobs | tenant | campaigns.id via campaign_id | Child of campaigns. |
| 63 | plivo_phone_pricing | global | - | Price catalogue. |
| 64 | user_kyc_documents | tenant | users.id via user_id | user_id NOT NULL -> users |
| 65 | twilio_openai_calls | tenant | users.id via user_id, campaigns.id via campaign_id, agents.id via agent_id | user_id nullable. Fallbacks: campaign, agent. |
| 66 | demo_sessions | ambiguous | - | Anonymous public demo; no owner. |
| 67 | lead_stages | tenant | users.id via user_id | is_default rows may be platform defaults; confirm. |
| 68 | leads | tenant | users.id via user_id | user_id NOT NULL -> users |
| 69 | lead_notes | tenant | users.id via user_id | user_id NOT NULL -> users |
| 70 | lead_activities | tenant | users.id via user_id | user_id NOT NULL -> users |
| 71 | crm_category_preferences | tenant | users.id via user_id | user_id NOT NULL -> users |
| 72 | website_widgets | tenant | users.id via user_id | user_id NOT NULL -> users |
| 73 | widget_call_sessions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 74 | api_keys | tenant | users.id via user_id | Looked up by hashed secret before the tenant is known; that lookup stays on the plain pool. |
| 75 | api_audit_logs | tenant | users.id via user_id | user_id NOT NULL -> users |
| 76 | api_rate_limits | tenant | api_keys.id via api_key_id | Child of api_keys. |
| 77 | sip_trunks | tenant | users.id via user_id | user_id NOT NULL -> users |
| 78 | sip_phone_numbers | tenant | users.id via user_id | user_id NOT NULL -> users |
| 79 | sip_calls | tenant | users.id via user_id | user_id NOT NULL; campaign_id has no cascade. |
| 80 | user_addresses | tenant | users.id via user_id | user_id NOT NULL -> users |
| 81 | user_feedback | tenant | users.id via user_id | user_id NOT NULL -> users |
| 82 | google_calendar_credentials | tenant | users.id via user_id | user_id NOT NULL -> users |
| 83 | google_sheets_credentials | tenant | users.id via user_id | user_id NOT NULL -> users |
| 84 | phone_release_retry_queue | ambiguous | - | user_id nullable; phone_number_id has no FK. |
| 85 | companies | root | - | Tenant registry (D1). Added in the schema and in DRAFT_companies_foundation.sql. No company_id on itself. |
| 86 | chatbots | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; composite unique (company_id, id). |
| 87 | chatbot_conversations | tenant | chatbots.id via chatbot_id | Composite FK (company_id, chatbot_id) to chatbots. New table, no backfill. |
| 88 | chatbot_messages | tenant | chatbot_conversations.id via conversation_id | Composite FK (company_id, conversation_id) to chatbot_conversations. New table, no backfill. |
| 89 | workforce_runs | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; no FK. |
| 90 | workforce_tasks | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; no FK. |
| 91 | workforce_tool_calls | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; no FK. |
| 92 | workforce_audit_events | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; append-only; no FK. |
| 93 | workforce_agents | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; PK (company_id, id); no FK. |
| 94 | clients | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 95 | client_merge_suggestions | tenant | clients.id via client_id, clients.id via duplicate_client_id | Workforce table (0014). New table, no backfill. Composite FKs to clients. |
| 96 | properties | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 97 | property_contacts | tenant | properties.id via property_id, clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 98 | property_issues | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 99 | work_orders | tenant | clients.id via client_id, properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 100 | visits | tenant | work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FK to work_orders. |
| 101 | visit_checklist_items | tenant | visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FK to visits. |
| 102 | visit_media | tenant | visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FK to visits. |
| 103 | job_notes | tenant | work_orders.id via work_order_id, visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 104 | job_signoffs | tenant | visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FK to visits. |
| 105 | job_material_lines | tenant | work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FK to work_orders. |
| 106 | inventory_items | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 107 | purchase_orders | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 108 | supplier_bills | tenant | purchase_orders.id via purchase_order_id | Workforce table (0014). New table, no backfill. Composite FK to purchase_orders. |
| 109 | end_of_lease_checklists | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 110 | crew_rosters | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 111 | timesheets | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 112 | timesheet_flags | tenant | timesheets.id via timesheet_id | Workforce table (0014). New table, no backfill. Composite FK to timesheets. |
| 113 | staff_tasks | tenant | work_orders.id via work_order_id, visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 114 | business_hours | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 115 | service_agreements | tenant | clients.id via client_id, properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 116 | maintenance_plans | tenant | clients.id via client_id, properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 117 | estimates | tenant | clients.id via client_id, properties.id via property_id, work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 118 | quote_requests | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 119 | opportunities | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 120 | disputes | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 121 | collection_notes | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 122 | reviews | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 123 | review_alerts | tenant | reviews.id via review_id | Workforce table (0014). New table, no backfill. Composite FK to reviews. |
| 124 | feedback_responses | tenant | visits.id via visit_id, clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 125 | complaints | tenant | clients.id via client_id, properties.id via property_id, work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 126 | compliance_certificates | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 127 | compliance_documents | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 128 | pool_profiles | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 129 | pool_equipment | tenant | pool_profiles.id via pool_profile_id | Workforce table (0014). New table, no backfill. Composite FK to pool_profiles. |
| 130 | pool_equipment_faults | tenant | pool_equipment.id via pool_equipment_id | Workforce table (0014). New table, no backfill. Composite FK to pool_equipment. |
| 131 | water_tests | tenant | pool_profiles.id via pool_profile_id | Workforce table (0014). New table, no backfill. Composite FK to pool_profiles. |
| 132 | water_test_results | tenant | water_tests.id via water_test_id, pool_profiles.id via pool_profile_id | Workforce table (0014). New table, no backfill. Composite FKs. |

## Blockers

- **B1 JWT claim (not decided).** `server/middleware/auth.ts` signs `{ userId, role }` at lines 198 and 326. The tenant value is taken from `req.user.company_id`, and auth sets `req.user` to `{ id, role }` only (line 52). The claim name and its source are not chosen. Do not guess them. `hybrid-auth.ts` team sessions need the same claim.
- **B2 Migration journal mismatch.** `migrations/meta/_journal.json` has 7 entries. The last is `0006_cultured_purifiers`, and no file has that tag (the file is `0006_add_default_campaign_type.sql`). `0007` and `0010` are on disk but not journaled. `scripts/run-safe-migration.mjs` names `008_...` and `009_...`, which are not on disk. The DRAFT must not be added to the runner until this is reconciled.
- **B3 No applied companies table.** The FK target is created only in `migrations/DRAFT_companies_foundation.sql`, which is not applied. `users.company` is free text, so there is no UUID to backfill `users.company_id` from (D1). The nullable `users.company_id` column is resolved in that draft; the FK to `companies` is deliberately not added.
- **B4 Type conflict across drafts.** `migrations/DRAFT_approvals.sql` and `migrations/DRAFT_chatbot.sql` declare `company_id varchar`. This draft and `withTenant` use `uuid`. One type has to win before any of them runs.
- **B5 Parents not found.** `calls` rows with NULL `user_id`, `campaign_id`, `incoming_connection_id` and an unmatched `widget_id` (no FK). `plivo_calls` and `twilio_openai_calls` with NULL user, campaign and agent. `webhook_logs` with NULL `webhook_id`. The 11 ambiguous tables have no parent by design. Step B3 lists the remaining counts.

## Decisions for review

- **D1** Company id source: a new `companies` table with a generated UUID per company (drafted in `migrations/DRAFT_companies_foundation.sql`), mapped from `users.company` text, or one company per user. Not chosen.
- **D2** The 11 ambiguous tables stay unscoped until a decision. The default is no `company_id`.
- **D3** FK delete behaviour is the default (NO ACTION). Not chosen.
- **D4** Indexes use CONCURRENTLY, so the runner must not wrap them in a transaction.
- **D5** `calls` falls back to `website_widgets` through `widget_id`. This is a join on a column with no FK.

## withTenant() bypass list (issue #252, 2026-11-18)

Method: every non-test, non-DRAFT `.ts` file under `server/` that imports the db handle or a pg pool, and whose text does not mention `withTenant`. The same rule runs in `tests/infrastructure/withtenant-bypass-ratchet.test.mjs`, which fails on any file not in `tests/infrastructure/withtenant-bypass-baseline.json`. The baseline holds 156 files.

Check by hand: `grep -rlE "import .*\b(db|pool)\b.* from" server --include=*.ts | xargs grep -L withTenant`

Groups (counts from the baseline; a file can appear in more than one group):

- Routes: about 71 files. Most are under `server/routes/webhook-modules/` (18), `server/routes/flow-automation/` (13), `server/routes/` (11), `server/routes/core/` (8), `server/routes/admin/` (8), and the engine route folders for Twilio, Plivo and Plivo-ElevenLabs (8 in total).
- WebSocket and voice streams: 19 files, including `server/routes/core/twilio-stream-upgrade.ts`, `server/routes/webhook-modules/elevenlabs-stream.ts`, `server/engines/plivo/routes/plivo-stream.ts`, `server/engines/twilio-openai/routes/twilio-openai-stream.ts`, `server/infrastructure/websocket/connection-manager.ts`, and `server/modules/widget/public-widget-routes.ts`.
- Workers, schedulers and jobs: about 21 files, including `server/services/campaign-scheduler.ts`, `server/services/campaign-executor.ts`, `server/services/webhook-retry-service.ts`, `server/services/phone-release-retry-worker.ts`, `server/services/phone-billing-cron.ts`, `server/services/credit-backfill-monitor.ts`, and `server/infrastructure/queue/campaign-recovery.service.ts`.
- Pre-tenant resolution (exceptions, must stay on the plain pool): `server/middleware/team-member-company.ts` (resolves the company from the parent user, so the company is not yet known). The refresh-token and API-key lookups in the tenancy table above are the same kind.

Converted in this change:

- `server/routes/flow-automation/shared.ts`, `validateWorkingHours`: the appointment-settings read now runs inside `withTenantTransaction` (the Drizzle variant of `withTenant`, from `server/infrastructure/database/tenant-transaction.ts`). It sets `app.company_id` but does not switch role, so it is weaker than `withTenant`. Test: `tests/infrastructure/flow-working-hours-tenant.test.mjs`.

Not converted, and why: the routes and workers above need a company id that is not in scope at their entry point (for example, a webhook carries a provider id, not a company). Each one needs its company resolved first, and that is a separate change per surface.

## Postgres isolation coverage (issue #127, 2026-11-18)

Premise correction: the issue says only Marketing and Inbox have a Postgres tenant-isolation check. On origin/main, `.github/workflows/pr-checks.yml` runs four such jobs: `marketing-postgres`, `inbox-postgres`, `tenant-postgres` (Settings, memberships, chatbot, workforce, scheduled booking mirror) and `approvals-postgres`.

Measured: 228 tables declare a `company_id` column (shared schema plus module files). 53 are named by a test under `tests/postgres/`. 175 are not, and they are listed in `tests/infrastructure/tenant-isolation-coverage-baseline.json`. The ratchet test `tests/infrastructure/tenant-isolation-coverage.test.mjs` fails on any new uncovered table and on baseline entries that become covered.

Limits: the check is a text match on the table name, so a mention counts. Tenant tables that key on `user_id` with no `company_id` column (the 104 tenant rows above, minus the company-keyed ones) are not in this count. Connector tables from #349 to #353 are on other branches, not on main, so they are not counted.

## Reconciliation and decision log (issue #250, 2026-11-18)

Checked on origin/main at a215fe9.

### Count

- `shared/schema.ts` declares 132 `pgTable` tables. The issue text says 91, which is stale. The 132 rows in the table above (104 tenant, 16 global, 11 ambiguous, 1 root) match the file.
- Module-owned tables outside `shared/schema.ts`: 115 `pgTable` declarations in 27 files under `server/modules/` (26 files under `chatbot/`, 1 file under `approvals/`). No tables in `plugins/` or `packages/`. No name clashes with `shared/schema.ts`.
- Migrations: 25 top-level `.sql` files in `migrations/`. `migrations/archive/` holds 25 `DRAFT_*.sql` files and a `README.md`. `migrations/candidates/` holds 4 files.

### Migration source gap (blocker)

- 7 of the 115 module tables have a `CREATE TABLE` in a migration: `approval_rules`, `approvals`, `chatbot_booking_reminder_attempts`, `chatbot_booking_reminder_sends`, `chatbot_event_outbox`, `chatbot_webhook_deliveries`, `chatbot_webhook_subscriptions`.
- The other 108 exist only as Drizzle declarations. Examples: `chatbot_commerce_orders`, `chatbot_carts`, `commerce_payment_intents`, `widget_embed_keys`. No SQL file in `migrations/` or `archive/` creates them. Production refuses `db:push`, so these tables have no reviewed route to production. This must be resolved before #251 can cover them.
- Of the 132 `shared/schema.ts` tables, 81 have no `CREATE TABLE` in any migration file. The remaining 51 do.

### Scope of the module tables

- Every module table declares a `company_id` column in its own block (checked by a text scan, so it is a heuristic). All 115 are tenant-owned for now. None is global. Review each one before #251 uses this list.

### Shared concepts

- `users`: ambiguous (D1). Holds free-text `company`. Not reconciled with Central here, because the repo has no Central canonical-entity document.
- `companies`: root. Created with `IF NOT EXISTS` by 0014 and in `DRAFT_companies_foundation.sql`.
- `notifications`: ambiguous (`user_id` NULL means broadcast).
- `invoices`: tenant, from `user_id`. The other apps' invoice tables were not checked in this repo.
- Open: agreement with Central on these four entities is not recorded in the repo. Needs a Central sign-off before #251 starts.

### Decision log

- D6 (2026-11-18, default, for review): `company_id` is `uuid NOT NULL` on every tenant table. Keys and foreign keys are composite `(company_id, id)` where a parent exists. Global tables get no `company_id`. The `varchar` type in `DRAFT_approvals.sql` and `DRAFT_chatbot.sql` (B4) loses to `uuid`, because `withTenant()` uses `uuid`.
- D7 (2026-11-18, default, for review): the 115 module tables are tenant-owned, based on the `company_id` scan above. Their migration source is recorded as missing for 108 of them (see the gap above).
- Not decided: D1 (company id source), D2 (ambiguous tables), D3 (FK delete behaviour). These remain open.
