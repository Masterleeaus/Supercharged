# Desk tenancy inventory

Status: classification for review. Schema columns (`shared/schema.ts`) and the draft `migrations/DRAFT_companies_foundation.sql` add nullable `company_id` and `companies`; nothing is applied and no route is changed.
Source: `shared/schema.ts`, 131 `pgTable` declarations (rows 1-83 as before, the `company_quiet_hours` table at row 19 created by `migrations/0015_company_quiet_hours.sql`, the three chatbot tables at rows 85-87, the five workforce tables at rows 88-92, and the 39 workforce tool tables at rows 93-131, created by `migrations/0014_workforce_tool_tables.sql`). The check is
`tests/infrastructure/tenancy-inventory.test.mjs`. Migration steps are in
`migrations/DRAFT_company_scope.sql`. The eight tenant tables from `DRAFT_chatbot.sql` and the workforce drafts are protected by row-level security in `migrations/DRAFT_company_scope_extension.sql`. A tenant table counts as covered if either draft protects it (decision 12).

## Coverage by draft

- Tenant tables (103): all covered. 55 by `DRAFT_company_scope.sql` (its backfill is blocked on decision D1), 8 by `DRAFT_company_scope_extension.sql`, 39 by `migrations/0014_workforce_tool_tables.sql`, 1 by `migrations/0015_company_quiet_hours.sql`. The 39 workforce tool tables are not in any archived draft. Their own migration creates each one with `company_id uuid NOT NULL REFERENCES companies(id)`, so they need no backfill and no STEP A-D work. The coverage test reads 0014 and 0015 for this. `company_quiet_hours` has `company_id` as its primary key, so it also needs no backfill. Row-level security for it is not in 0015; it is still open under the tenancy plan.
- Not covered by any draft, by class: the 11 ambiguous tables (`users`, `otp_verifications`, `synced_voices`, `phone_numbers`, `notifications`, `prompt_templates`, `audit_logs`, `payment_webhook_queue`, `plivo_phone_numbers`, `demo_sessions`, `phone_release_retry_queue`) and the 16 global tables. `companies` is the root.
- Open gap: `users.company_id` is the source for every backfill and its value mapping is still open (D1).

## Classes

- **tenant**: holds one company's data. Gets `company_id` (nullable first, then backfilled, then FK, then NOT NULL). The parent column shows the backfill source.
- **global**: platform catalogue, shared credential pool, or site config. No `company_id`.
- **ambiguous**: the owner cannot be decided from the schema. Not drafted until a decision is made.
- **root**: the tenant registry itself (`companies`). It is not company-owned, so it has no `company_id`.

## Counts

- tenant: 103
- global: 16
- ambiguous: 11
- root: 1 (companies)
- total: 131

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
| 20 | llm_models | global | - | Model catalogue. |
| 21 | supported_languages | global | - | Language catalogue. |
| 22 | credit_packages | global | - | Credit package catalogue. |
| 23 | user_subscriptions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 24 | phone_number_rentals | tenant | users.id via user_id | user_id NOT NULL -> users |
| 25 | usage_records | tenant | users.id via user_id | user_id NOT NULL -> users |
| 26 | webhooks | tenant | users.id via user_id | Legacy table (Drizzle legacyWebhooks). |
| 27 | webhook_deliveries | tenant | webhooks.id via webhook_id | Child of legacy webhooks. |
| 28 | notifications | ambiguous | - | user_id NULL for broadcast notifications. |
| 29 | email_templates | global | - | Platform email templates; no owner column. |
| 30 | prompt_templates | ambiguous | - | user_id NULL marks a system template. |
| 31 | agent_versions | tenant | agents.id via agent_id | Child of agents. |
| 32 | audit_logs | ambiguous | - | user_id nullable; platform-wide and tenant audit mixed. |
| 33 | platform_languages | global | - | Language catalogue. |
| 34 | twilio_countries | global | - | Country catalogue. |
| 35 | user_knowledge_storage_limits | tenant | users.id via user_id | user_id NOT NULL -> users |
| 36 | knowledge_chunks | tenant | users.id via user_id | Has user_id and knowledge_base_id; uses user_id. |
| 37 | knowledge_processing_queue | tenant | users.id via user_id | user_id NOT NULL -> users |
| 38 | flows | tenant | users.id via user_id | is_template rows may be platform-wide; confirm before backfill. |
| 39 | flow_executions | tenant | flows.id via flow_id | Child of flows. |
| 40 | flow_test_queue | tenant | users.id via user_id | user_id NOT NULL -> users |
| 41 | webhook_subscriptions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 42 | webhook_logs | tenant | webhook_subscriptions.id via webhook_id | Drizzle webhookDeliveryLogs. webhook_id nullable; NULL rows have no parent. |
| 43 | appointments | tenant | users.id via user_id | user_id NOT NULL -> users |
| 44 | appointment_settings | tenant | users.id via user_id | user_id NOT NULL -> users |
| 45 | forms | tenant | users.id via user_id | user_id NOT NULL -> users |
| 46 | form_fields | tenant | forms.id via form_id | Child of forms. |
| 47 | form_submissions | tenant | forms.id via form_id | Child of forms. |
| 48 | seo_settings | global | - | Site-wide SEO settings; updated_by only. |
| 49 | analytics_scripts | global | - | Site-wide script injection; updated_by only. |
| 50 | payment_transactions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 51 | refunds | tenant | users.id via user_id | user_id NOT NULL -> users |
| 52 | invoices | tenant | users.id via user_id | user_id NOT NULL -> users |
| 53 | payment_webhook_queue | ambiguous | - | user_id nullable; gateway events can arrive before the user is resolved. |
| 54 | email_notification_settings | global | - | Platform event config; updated_by only. |
| 55 | banned_words | global | - | Platform moderation list; created_by only. |
| 56 | content_violations | tenant | users.id via user_id | user_id NOT NULL -> users |
| 57 | openai_credentials | global | - | Platform API-key pool; no owner column. |
| 58 | plivo_credentials | global | - | Platform provider credentials; no owner column. |
| 59 | plivo_phone_numbers | ambiguous | - | user_id nullable; pool rows likely unowned, as in phone_numbers. |
| 60 | plivo_calls | tenant | users.id via user_id, campaigns.id via campaign_id, agents.id via agent_id | user_id nullable. Fallbacks: campaign, agent. |
| 61 | campaign_jobs | tenant | campaigns.id via campaign_id | Child of campaigns. |
| 62 | plivo_phone_pricing | global | - | Price catalogue. |
| 63 | user_kyc_documents | tenant | users.id via user_id | user_id NOT NULL -> users |
| 64 | twilio_openai_calls | tenant | users.id via user_id, campaigns.id via campaign_id, agents.id via agent_id | user_id nullable. Fallbacks: campaign, agent. |
| 65 | demo_sessions | ambiguous | - | Anonymous public demo; no owner. |
| 66 | lead_stages | tenant | users.id via user_id | is_default rows may be platform defaults; confirm. |
| 67 | leads | tenant | users.id via user_id | user_id NOT NULL -> users |
| 68 | lead_notes | tenant | users.id via user_id | user_id NOT NULL -> users |
| 69 | lead_activities | tenant | users.id via user_id | user_id NOT NULL -> users |
| 70 | crm_category_preferences | tenant | users.id via user_id | user_id NOT NULL -> users |
| 71 | website_widgets | tenant | users.id via user_id | user_id NOT NULL -> users |
| 72 | widget_call_sessions | tenant | users.id via user_id | user_id NOT NULL -> users |
| 73 | api_keys | tenant | users.id via user_id | Looked up by hashed secret before the tenant is known; that lookup stays on the plain pool. |
| 74 | api_audit_logs | tenant | users.id via user_id | user_id NOT NULL -> users |
| 75 | api_rate_limits | tenant | api_keys.id via api_key_id | Child of api_keys. |
| 76 | sip_trunks | tenant | users.id via user_id | user_id NOT NULL -> users |
| 77 | sip_phone_numbers | tenant | users.id via user_id | user_id NOT NULL -> users |
| 78 | sip_calls | tenant | users.id via user_id | user_id NOT NULL; campaign_id has no cascade. |
| 79 | user_addresses | tenant | users.id via user_id | user_id NOT NULL -> users |
| 80 | user_feedback | tenant | users.id via user_id | user_id NOT NULL -> users |
| 81 | google_calendar_credentials | tenant | users.id via user_id | user_id NOT NULL -> users |
| 82 | google_sheets_credentials | tenant | users.id via user_id | user_id NOT NULL -> users |
| 83 | phone_release_retry_queue | ambiguous | - | user_id nullable; phone_number_id has no FK. |
| 84 | companies | root | - | Tenant registry (D1). Added in the schema and in DRAFT_companies_foundation.sql. No company_id on itself. |
| 85 | chatbots | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; composite unique (company_id, id). |
| 86 | chatbot_conversations | tenant | chatbots.id via chatbot_id | Composite FK (company_id, chatbot_id) to chatbots. New table, no backfill. |
| 87 | chatbot_messages | tenant | chatbot_conversations.id via conversation_id | Composite FK (company_id, conversation_id) to chatbot_conversations. New table, no backfill. |
| 88 | workforce_runs | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; no FK. |
| 89 | workforce_tasks | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; no FK. |
| 90 | workforce_tool_calls | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; no FK. |
| 91 | workforce_audit_events | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; append-only; no FK. |
| 92 | workforce_agents | tenant | companies.id via company_id | New table, no backfill. company_id NOT NULL; PK (company_id, id); no FK. |
| 93 | clients | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 94 | client_merge_suggestions | tenant | clients.id via client_id, clients.id via duplicate_client_id | Workforce table (0014). New table, no backfill. Composite FKs to clients. |
| 95 | properties | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 96 | property_contacts | tenant | properties.id via property_id, clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 97 | property_issues | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 98 | work_orders | tenant | clients.id via client_id, properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 99 | visits | tenant | work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FK to work_orders. |
| 100 | visit_checklist_items | tenant | visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FK to visits. |
| 101 | visit_media | tenant | visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FK to visits. |
| 102 | job_notes | tenant | work_orders.id via work_order_id, visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 103 | job_signoffs | tenant | visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FK to visits. |
| 104 | job_material_lines | tenant | work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FK to work_orders. |
| 105 | inventory_items | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 106 | purchase_orders | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 107 | supplier_bills | tenant | purchase_orders.id via purchase_order_id | Workforce table (0014). New table, no backfill. Composite FK to purchase_orders. |
| 108 | end_of_lease_checklists | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 109 | crew_rosters | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 110 | timesheets | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 111 | timesheet_flags | tenant | timesheets.id via timesheet_id | Workforce table (0014). New table, no backfill. Composite FK to timesheets. |
| 112 | staff_tasks | tenant | work_orders.id via work_order_id, visits.id via visit_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 113 | business_hours | tenant | companies.id via company_id | Workforce table (0014). New table, no backfill. company_id NOT NULL; no parent FK. |
| 114 | service_agreements | tenant | clients.id via client_id, properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 115 | maintenance_plans | tenant | clients.id via client_id, properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 116 | estimates | tenant | clients.id via client_id, properties.id via property_id, work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 117 | quote_requests | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 118 | opportunities | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 119 | disputes | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 120 | collection_notes | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 121 | reviews | tenant | clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FK to clients. |
| 122 | review_alerts | tenant | reviews.id via review_id | Workforce table (0014). New table, no backfill. Composite FK to reviews. |
| 123 | feedback_responses | tenant | visits.id via visit_id, clients.id via client_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 124 | complaints | tenant | clients.id via client_id, properties.id via property_id, work_orders.id via work_order_id | Workforce table (0014). New table, no backfill. Composite FKs. |
| 125 | compliance_certificates | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 126 | compliance_documents | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 127 | pool_profiles | tenant | properties.id via property_id | Workforce table (0014). New table, no backfill. Composite FK to properties. |
| 128 | pool_equipment | tenant | pool_profiles.id via pool_profile_id | Workforce table (0014). New table, no backfill. Composite FK to pool_profiles. |
| 129 | pool_equipment_faults | tenant | pool_equipment.id via pool_equipment_id | Workforce table (0014). New table, no backfill. Composite FK to pool_equipment. |
| 130 | water_tests | tenant | pool_profiles.id via pool_profile_id | Workforce table (0014). New table, no backfill. Composite FK to pool_profiles. |
| 131 | water_test_results | tenant | water_tests.id via water_test_id, pool_profiles.id via pool_profile_id | Workforce table (0014). New table, no backfill. Composite FKs. |

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
