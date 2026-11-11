# Company_id inventory (issue #51)

Date: 2026-11-09. This is an inventory only. No migration, schema column, or test was changed.

## Result

- Promoted migrations create 144 tables. 49 have `company_id`. 94 have none. The tenant root `companies` also has none, by design.
- `shared/schema.ts` declares 131 tables. 88 of them have no `company_id` in promoted migrations. For 70 of those, schema.ts has the column but no promoted migration adds it, so schema.ts is ahead of the migrations. 18 have it nowhere.
- 36 tables are outside schema.ts. 18 are created by promoted migrations (11 `ve_*`, 4 `inbox_*`, 2 approval tables, `fonoster_credentials`). Another 18 exist only in archived drafts under `migrations/archive/`, which are not run. Five workforce tables are declared in schema.ts but exist only in archived drafts.
- Proposed classes across 167 rows: tenant 134, global 19 (includes `companies`), ambiguous 14.
- `tests/infrastructure/tenancy-inventory.test.mjs`: 9 of 13 pass. All 4 failures come from one table, `company_quiet_hours` (migration 0015). It is in schema.ts (131 tables) but not in `docs/TENANCY-INVENTORY.md` (130 rows). The test expects 130. Not fixed in this pass.

## Method

- Schema: each `pgTable` block. `company_id` is read from `uuid("company_id")` or the `wfCompany()` helper. Comments are ignored.
- Promoted: the 18 files named in `scripts/run-safe-migration.mjs`, which are `0000_damp_spectrum.sql` (the base) plus the runner's list. `CREATE TABLE` and `ALTER TABLE` statements were parsed.
- Archive: all of `migrations/archive/*.sql`, plus top-level `add_missing_columns.sql` (not in the runner). Shown as "not run".
- Classes come from `docs/TENANCY-INVENTORY.md` where that file has a row. New rows follow the same rules.

## Decisions made in this pass

- `companies` is class global (tenant registry), not tenant.
- `company_quiet_hours` is tenant. Its `company_id` is the primary key, from migration 0015.
- Migration-only tables with `user_id` are tenant.
- `ve_freeswitch_nodes` and `fonoster_credentials` have no owner column. They are global, like the other credential pools.
- Archive-only tables are tenant when their draft adds `company_id`.
- `course_lesson_revisions` and `course_revision_pins` are ambiguous. No draft settles whether course content is platform-wide.

## Top questions for the owner

1. Where does a user's company UUID come from? `users.company` is free text today. This is decision D1 in `docs/TENANCY-INVENTORY.md`.
2. Are phone-number, voice and SIP-gateway pools platform-wide until assigned? Affects `phone_numbers`, `plivo_phone_numbers`, `synced_voices`, `ve_sip_gateways`.
3. Is course content platform-wide, or written per company? Affects `course_lesson_revisions` and `course_revision_pins`.

The full question for each ambiguous row is in the last column of the table.

## Table

"Not run" means the file is in `migrations/archive/` and the runner skips it. "Draft" names the archived file that adds or creates `company_id`.

| # | Table | In schema.ts | In promoted migrations | Migration and archive drafts | Proposed class | Question (ambiguous rows only) |
|---|---|---|---|---|---|---|
| 1 | `users` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | Where does a user's company UUID come from? users.company is free text today: a new companies table, one company per user, or a mapping from the text? (decision D1) |
| 2 | `otp_verifications` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | Pre-auth rows are keyed by email with no user. Stay unscoped until login, or take the company of the email's sign-up? |
| 3 | `refresh_tokens` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 4 | `eleven_labs_credentials` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 5 | `synced_voices` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | The row points at a shared credential pool and public_owner_id has no FK. Is a synced voice owned by one company, or platform-wide? |
| 6 | `agents` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 7 | `knowledge_base` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 8 | `incoming_agents` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 9 | `phone_numbers` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | user_id is NULL for system-pool numbers. Are unassigned pool numbers platform-wide, with company_id set only when assigned? |
| 10 | `incoming_connections` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 11 | `campaigns` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_campaigns, archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 12 | `contacts` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 13 | `calls` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 14 | `credit_transactions` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 15 | `tools` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 16 | `voices` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 17 | `plans` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 18 | `global_settings` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 19 | `company_quiet_hours` | yes | yes | 0015_company_quiet_hours (created with company_id) | tenant | - |
| 20 | `llm_models` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 21 | `supported_languages` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 22 | `credit_packages` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 23 | `user_subscriptions` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 24 | `phone_number_rentals` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 25 | `usage_records` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 26 | `webhooks` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 27 | `webhook_deliveries` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 28 | `notifications` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | user_id is NULL for broadcast notices. Should a broadcast fan out one row per company, or stay unscoped? |
| 29 | `email_templates` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 30 | `prompt_templates` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | user_id NULL marks a system template. Are system templates platform-wide, with company-owned templates scoped by company? |
| 31 | `agent_versions` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 32 | `audit_logs` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | Platform and tenant audit events share one table. Should rows about a company carry its company_id, with platform rows left NULL? |
| 33 | `platform_languages` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 34 | `twilio_countries` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 35 | `user_knowledge_storage_limits` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 36 | `knowledge_chunks` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 37 | `knowledge_processing_queue` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 38 | `flows` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 39 | `flow_executions` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 40 | `flow_test_queue` | yes | no | 0004_add_missing_tables (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 41 | `webhook_subscriptions` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 42 | `webhook_logs` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 43 | `appointments` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 44 | `appointment_settings` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 45 | `forms` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 46 | `form_fields` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 47 | `form_submissions` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 48 | `seo_settings` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 49 | `analytics_scripts` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 50 | `payment_transactions` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 51 | `refunds` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 52 | `invoices` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 53 | `payment_webhook_queue` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | Gateway events can arrive before the user is resolved. Can the company be read from the gateway account, or must the row wait until matched? |
| 54 | `email_notification_settings` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 55 | `banned_words` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 56 | `content_violations` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 57 | `openai_credentials` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 58 | `plivo_credentials` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 59 | `plivo_phone_numbers` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | Pool rows are likely unowned, as with phone_numbers. Does a Plivo number belong to one company once assigned? |
| 60 | `plivo_calls` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 61 | `campaign_jobs` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 62 | `plivo_phone_pricing` | no | no | 0000_damp_spectrum (no company_id) | global | - |
| 63 | `user_kyc_documents` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 64 | `twilio_openai_calls` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 65 | `demo_sessions` | no | no | 0000_damp_spectrum (no company_id) | ambiguous | Anonymous public demo with no owner. Should demo sessions belong to a demo company, or stay platform-wide? |
| 66 | `lead_stages` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 67 | `leads` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 68 | `lead_notes` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 69 | `lead_activities` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 70 | `crm_category_preferences` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 71 | `website_widgets` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 72 | `widget_call_sessions` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 73 | `api_keys` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 74 | `api_audit_logs` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 75 | `api_rate_limits` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 76 | `sip_trunks` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 77 | `sip_phone_numbers` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 78 | `sip_calls` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 79 | `user_addresses` | yes | no | 0000_damp_spectrum (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 80 | `user_feedback` | yes | no | 0004_add_missing_tables (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 81 | `google_calendar_credentials` | yes | no | 0004_add_missing_tables (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 82 | `google_sheets_credentials` | yes | no | 0002_add_google_sheets_credentials (no company_id); not run: archive/DRAFT_companies_foundation, archive/DRAFT_company_scope | tenant | - |
| 83 | `phone_release_retry_queue` | yes | no | 0004_add_missing_tables (no company_id); not run: archive/DRAFT_companies_foundation | ambiguous | user_id is nullable and phone_number_id has no FK. Should a release retry take the company of the number it releases? |
| 84 | `companies` | no | no | 0014_workforce_tool_tables (guard create, no company_id) | global (root registry) | - |
| 85 | `chatbots` | yes | yes | 0010c_chatbot (created with company_id); not run: archive/DRAFT_chatbot | tenant | - |
| 86 | `chatbot_conversations` | yes | yes | 0010c_chatbot (created with company_id); not run: archive/DRAFT_chatbot | tenant | - |
| 87 | `chatbot_messages` | yes | yes | 0010c_chatbot (created with company_id); not run: archive/DRAFT_chatbot | tenant | - |
| 88 | `workforce_runs` | yes | no | none promoted; not run: archive/DRAFT_workforce_runs | tenant | - |
| 89 | `workforce_tasks` | yes | no | none promoted; not run: archive/DRAFT_workforce_runs | tenant | - |
| 90 | `workforce_tool_calls` | yes | no | none promoted; not run: archive/DRAFT_workforce_runs | tenant | - |
| 91 | `workforce_audit_events` | yes | no | none promoted; not run: archive/DRAFT_workforce_runs | tenant | - |
| 92 | `workforce_agents` | yes | no | none promoted; not run: archive/DRAFT_workforce_agents | tenant | - |
| 93 | `clients` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 94 | `client_merge_suggestions` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 95 | `properties` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 96 | `property_contacts` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 97 | `property_issues` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 98 | `work_orders` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 99 | `visits` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 100 | `visit_checklist_items` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 101 | `visit_media` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 102 | `job_notes` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 103 | `job_signoffs` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 104 | `job_material_lines` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 105 | `inventory_items` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 106 | `purchase_orders` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 107 | `supplier_bills` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 108 | `end_of_lease_checklists` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 109 | `crew_rosters` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 110 | `timesheets` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 111 | `timesheet_flags` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 112 | `staff_tasks` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 113 | `business_hours` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 114 | `service_agreements` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 115 | `maintenance_plans` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 116 | `estimates` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 117 | `quote_requests` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 118 | `opportunities` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 119 | `disputes` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 120 | `collection_notes` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 121 | `reviews` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 122 | `review_alerts` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 123 | `feedback_responses` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 124 | `complaints` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 125 | `compliance_certificates` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 126 | `compliance_documents` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 127 | `pool_profiles` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 128 | `pool_equipment` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 129 | `pool_equipment_faults` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 130 | `water_tests` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 131 | `water_test_results` | yes | yes | 0014_workforce_tool_tables (created with company_id) | tenant | - |
| 132 | `action_ledger` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_action_ledger | tenant | - |
| 133 | `approval_rules` | no (not in schema.ts) | yes | 0010b_approvals (created with company_id); not run: archive/DRAFT_approvals | tenant | - |
| 134 | `approvals` | no (not in schema.ts) | yes | 0010b_approvals (created with company_id); not run: archive/DRAFT_approvals | tenant | - |
| 135 | `campaign_audiences` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_campaigns | tenant | - |
| 136 | `campaign_contacts` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_campaigns | tenant | - |
| 137 | `campaign_opt_ins` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_campaigns | tenant | - |
| 138 | `campaign_send_jobs` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_campaigns | tenant | - |
| 139 | `campaign_steps` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_campaigns | tenant | - |
| 140 | `campaign_unsubscribes` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_campaigns | tenant | - |
| 141 | `comms_audit_events` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_comms_company_id | tenant | - |
| 142 | `comms_saved_replies` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_comms_company_id | tenant | - |
| 143 | `comms_segments` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_comms_company_id | tenant | - |
| 144 | `comms_suppressions` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_comms_company_id | tenant | - |
| 145 | `content_items` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_marketing | tenant | - |
| 146 | `course_lesson_revisions` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_course_knowledge | ambiguous | Are course lessons platform-wide content, or does each company write its own? The answer also decides course_revision_pins. |
| 147 | `course_revision_pins` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_course_knowledge | ambiguous | Same question as course_lesson_revisions. If lessons are platform-wide, these pins are platform-wide too. |
| 148 | `fonoster_credentials` | no (not in schema.ts) | no | 0000_damp_spectrum (no company_id) | global | - |
| 149 | `inbox_messages` | no (not in schema.ts) | yes | 0010a_inbox (created with company_id); not run: archive/DRAFT_inbox | tenant | - |
| 150 | `inbox_participants` | no (not in schema.ts) | yes | 0010a_inbox (created with company_id); not run: archive/DRAFT_inbox | tenant | - |
| 151 | `inbox_thread_participants` | no (not in schema.ts) | yes | 0010a_inbox (created with company_id); not run: archive/DRAFT_inbox | tenant | - |
| 152 | `inbox_threads` | no (not in schema.ts) | yes | 0010a_inbox (created with company_id); not run: archive/DRAFT_inbox | tenant | - |
| 153 | `landing_pages` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_marketing | tenant | - |
| 154 | `shadow_changes` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_shadow_changes | tenant | - |
| 155 | `ve_call_recordings` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | tenant | - |
| 156 | `ve_conversation_memory` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | tenant | - |
| 157 | `ve_customer_facts` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | tenant | - |
| 158 | `ve_customer_memory` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | tenant | - |
| 159 | `ve_freeswitch_nodes` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | global | - |
| 160 | `ve_llm_cache` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | tenant | - |
| 161 | `ve_provider_configs` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | tenant | - |
| 162 | `ve_sessions` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | tenant | - |
| 163 | `ve_sip_gateways` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | ambiguous | No owner column. Is a SIP gateway shared by the platform, or owned by one company? |
| 164 | `ve_usage_tracking` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | tenant | - |
| 165 | `ve_voice_agents` | no (not in schema.ts) | no | 008_add_ve_session_id_and_voice_engine_tables (no company_id) | tenant | - |
| 166 | `workforce_budget_usage` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_workforce_budgets | tenant | - |
| 167 | `workforce_control_state` | no (not in schema.ts) | no | none promoted; not run: archive/DRAFT_workforce_control_state | tenant | - |
