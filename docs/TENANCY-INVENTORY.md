# Desk tenancy inventory

Update (2026-11-09): the migration-runner statements in this file about 008 and 009 not existing, and about 0011 and 0013 being unlisted, are out of date. The runner now lists 17 required files, and all of them exist. Other statements here are unchanged.

Status: classification for review. Schema columns (`shared/schema.ts`) and the draft `migrations/DRAFT_companies_foundation.sql` add nullable `company_id` and `companies`; nothing is applied and no route is changed.
Source: `shared/schema.ts`, 130 `pgTable` declarations (rows 1-83 as before, the three chatbot tables at rows 84-86, the five workforce tables at rows 87-91, and the 39 workforce tool tables at rows 92-130, created by `migrations/0014_workforce_tool_tables.sql`). The check is
`tests/infrastructure/tenancy-inventory.test.mjs`. Migration steps are in
`migrations/DRAFT_company_scope.sql`. The eight tenant tables from `DRAFT_chatbot.sql` and the workforce drafts are protected by row-level security in `migrations/DRAFT_company_scope_extension.sql`. A tenant table counts as covered if either draft protects it (decision 12).

## Coverage by draft

- Tenant tables (102): all covered. 55 by `DRAFT_company_scope.sql` (its backfill is blocked on decision D1), 8 by `DRAFT_company_scope_extension.sql`, 39 by `migrations/0014_workforce_tool_tables.sql`. The 39 workforce tool tables are not in any archived draft. Their own migration creates each one with `company_id uuid NOT NULL REFERENCES companies(id)`, so they need no backfill and no STEP A-D work. The coverage test reads 0014 for this.
- Not covered by any draft, by class: the 11 ambiguous tables (`users`, `otp_verifications`, `synced_voices`, `phone_numbers`, `notifications`, `prompt_templates`, `audit_logs`, `payment_webhook_queue`, `plivo_phone_numbers`, `demo_sessions`, `phone_release_retry_queue`) and the 16 global tables. `companies` is the root.
- Open gap: `users.company_id` is the source for every backfill and its value mapping is still open (D1).

## Classes

- **tenant**: holds one company's data. Gets `company_id` (nullable first, then backfilled, then FK, then NOT NULL). The parent column shows the backfill source.
- **global**: platform catalogue, shared credential pool, or site config. No `company_id`.
- **ambiguous**: the owner cannot be decided from the schema. Not drafted until a decision is made.
- **root**: the tenant registry itself (`companies`). It is not company-owned, so it has no `company_id`.

## Counts

- tenant: 102
- global: 16
- ambiguous: 11
- root: 1 (companies)
- total: 130

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
| 19 | llm_models | global | - | Model catalogue. |
| 20 | supported_languages | global | - | Language catalogue. |
| 21 | credit_packages | global | - | Credit package catalogue. |
| 22 | user_subscriptions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 23 | phone_number_rentals | tenant | users.id via user_id | user_id NOT NULL -> users |
| 24 | usage_records | tenant | users.id via user_id | user_id NOT NULL -> users |
| 25 | webhooks | tenant | users.id via user_id | Legacy table (Drizzle legacyWebhooks). |
| 26 | webhook_deliveries | tenant | webhooks.id via webhook_id | Child of legacy webhooks. |
| 27 | notifications | ambiguous | - | user_id NULL for broadcast notifications. |
| 28 | email_templates | global | - | Platform email templates; no owner column. |
| 29 | prompt_templates | ambiguous | - | user_id NULL marks a system template. |
| 30 | agent_versions | tenant | agents.id via agent_id | Child of agents. |
| 31 | audit_logs | ambiguous | - | user_id nullable; platform-wide and tenant audit mixed. |
| 32 | platform_languages | global | - | Language catalogue. |
| 33 | twilio_countries | global | - | Country catalogue. |
| 34 | user_knowledge_storage_limits | tenant | users.id via user_id | user_id NOT NULL -> users |
| 35 | knowledge_chunks | tenant | users.id via user_id | Has user_id and knowledge_base_id; uses user_id. |
| 36 | knowledge_processing_queue | tenant | users.id via user_id | user_id NOT NULL -> users |
| 37 | flows | tenant | users.id via user_id | is_template rows may be platform-wide; confirm before backfill. |
| 38 | flow_executions | tenant | flows.id via flow_id | Child of flows. |
| 39 | flow_test_queue | tenant | users.id via user_id | user_id NOT NULL -> users |
| 40 | webhook_subscriptions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 41 | webhook_logs | tenant | webhook_subscriptions.id via webhook_id | Drizzle webhookDeliveryLogs. webhook_id nullable; NULL rows have no parent. |
| 42 | appointments | tenant | users.id via user_id | user_id NOT NULL -> users |
| 43 | appointment_settings | tenant | users.id via user_id | user_id NOT NULL -> users |
| 44 | forms | tenant | users.id via user_id | user_id NOT NULL -> users |
| 45 | form_fields | tenant | forms.id via form_id | Child of forms. |
| 46 | form_submissions | tenant | forms.id via form_id | Child of forms. |
| 47 | seo_settings | global | - | Site-wide SEO settings; updated_by only. |
| 48 | analytics_scripts | global | - | Site-wide script injection; updated_by only. |
| 49 | payment_transactions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 50 | refunds | tenant | users.id via user_id | user_id NOT NULL -> users |
| 51 | invoices | tenant | users.id via user_id | user_id NOT NULL -> users |
| 52 | payment_webhook_queue | ambiguous | - | user_id nullable; gateway events can arrive before the user is resolved. |
| 53 | email_notification_settings | global | - | Platform event config; updated_by only. |
| 54 | banned_words | global | - | Platform moderation list; created_by only. |
| 55 | content_violations | tenant | users.id via user_id | user_id NOT NULL -> users |
| 56 | openai_credentials | global | - | Platform API-key pool; no owner column. |
| 57 | plivo_credentials | global | - | Platform provider credentials; no owner column. |
| 58 | plivo_phone_numbers | ambiguous | - | user_id nullable; pool rows likely unowned, as in phone_numbers. |
| 59 | plivo_calls | tenant | users.id via user_id, campaigns.id via campaign_id, agents.id via agent_id | user_id nullable. Fallbacks: campaign, agent. |
| 60 | campaign_jobs | tenant | campaigns.id via campaign_id | Child of campaigns. |
| 61 | plivo_phone_pricing | global | - | Price catalogue. |
| 62 | user_kyc_documents | tenant | users.id via user_id | user_id NOT NULL -> users |
| 63 | twilio_openai_calls | tenant | users.id via user_id, campaigns.id via campaign_id, agents.id via agent_id | user_id nullable. Fallbacks: campaign, agent. |
| 64 | demo_sessions | ambiguous | - | Anonymous public demo; no owner. |
| 65 | lead_stages | tenant | users.id via user_id | is_default rows may be platform defaults; confirm. |
| 66 | leads | tenant | users.id via user_id | user_id NOT NULL -> users |
| 67 | lead_notes | tenant | users.id via user_id | user_id NOT NULL -> users |
| 68 | lead_activities | tenant | users.id via user_id | user_id NOT NULL -> users |
| 69 | crm_category_preferences | tenant | users.id via user_id | user_id NOT NULL -> users |
| 70 | website_widgets | tenant | users.id via user_id | user_id NOT NULL -> users |
| 71 | widget_call_sessions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 72 | api_keys | tenant | users.id via user_id | Looked up by hashed secret before the tenant is known; that lookup stays on the plain pool. |
| 73 | api_audit_logs | tenant | users.id via user_id | user_id NOT NULL -> users |
| 74 | api_rate_limits | tenant | api_keys.id via api_key_id | Child of api_keys. |
| 75 | sip_trunks | tenant | users.id via user_id | user_id NOT NULL -> users |
| 76 | sip_phone_numbers | tenant | users.id via user_id | user_id NOT NULL -> users |
| 77 | sip_calls | tenant | users.id via user_id | user_id NOT NULL; campaign_id has no cascade. |
| 78 | user_addresses | tenant | users.id via user_id | user_id NOT NULL -> users |
| 79 | user_feedback | tenant | users.id via user_id | user_id NOT NULL -> users |
| 80 | google_calendar_credentials | tenant | users.id via user_id | user_id NOT NULL -> users |
| 81 | google_sheets_credentials | tenant | users.id via user_id | user_id NOT NULL -> users |
| 82 | phone_release_retry_queue | ambiguous | - | user_id nullable; phone_number_id has no FK. |
| 83 | companies | root | - | Tenant registry (D1). Added in the schema and in DRAFT_companies_foundation.sql. No company_id on itself. |
| 84 | chatbots | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; composite unique (company_id, id). |
| 85 | chatbot_conversations | tenant | chatbots.id via chatbot_id | Composite FK (company_id, chatbot_id) to chatbots. New table, no backfill. |
| 86 | chatbot_messages | tenant | chatbot_conversations.id via conversation_id | Composite FK (company_id, conversation_id) to chatbot_conversations. New table, no backfill. |
| 87 | workforce_runs | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; no FK. |
| 88 | workforce_tasks | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; no FK. |
| 89 | workforce_tool_calls | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; no FK. |
| 90 | workforce_audit_events | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; append-only; no FK. |
| 91 | workforce_agents | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; PK (company_id, id); no FK. |
| 92 | clients | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 93 | client_merge_suggestions | tenant | clients.id via client_id, clients.id via duplicate_client_id | Workforce table (0014). New table, no backfill. Composite FKs to clients. |
| 94 | properties | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 95 | property_contacts | tenant | properties.id via property_id, clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 96 | property_issues | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 97 | work_orders | tenant | clients.id via client_id, properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 98 | visits | tenant | work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FK to work_orders. |
| 99 | visit_checklist_items | tenant | visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FK to visits. |
| 100 | visit_media | tenant | visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FK to visits. |
| 101 | job_notes | tenant | work_orders.id via work_order_id, visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 102 | job_signoffs | tenant | visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FK to visits. |
| 103 | job_material_lines | tenant | work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FK to work_orders. |
| 104 | inventory_items | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 105 | purchase_orders | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 106 | supplier_bills | tenant | purchase_orders.id via purchase_order_id | Workforce table (0014). New table, no backfill. Composite FK to purchase_orders. |
| 107 | end_of_lease_checklists | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 108 | crew_rosters | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 109 | timesheets | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 110 | timesheet_flags | tenant | timesheets.id via timesheet_id | Workforce table (0014). New table, no backfill. Composite FK to timesheets. |
| 111 | staff_tasks | tenant | work_orders.id via work_order_id, visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 112 | business_hours | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 113 | service_agreements | tenant | clients.id via client_id, properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 114 | maintenance_plans | tenant | clients.id via client_id, properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 115 | estimates | tenant | clients.id via client_id, properties.id via property_id, work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 116 | quote_requests | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 117 | opportunities | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 118 | disputes | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 119 | collection_notes | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 120 | reviews | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 121 | review_alerts | tenant | reviews.id via review_id | Workforce table (0014). New table, no backfill. Composite FK to reviews. |
| 122 | feedback_responses | tenant | visits.id via visit_id, clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 123 | complaints | tenant | clients.id via client_id, properties.id via property_id, work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 124 | compliance_certificates | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 125 | compliance_documents | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 126 | pool_profiles | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 127 | pool_equipment | tenant | pool_profiles.id via pool_profile_id | Workforce table (0014). New table, no backfill. Composite FK to pool_profiles. |
| 128 | pool_equipment_faults | tenant | pool_equipment.id via pool_equipment_id | Workforce table (0014). New table, no backfill. Composite FK to pool_equipment. |
| 129 | water_tests | tenant | pool_profiles.id via pool_profile_id | Workforce table (0014). New table, no backfill. Composite FK to pool_profiles. |
| 130 | water_test_results | tenant | water_tests.id via water_test_id, pool_profiles.id via pool_profile_id | Workforce table (0014). New table, no backfill. Composite FKs. |

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
