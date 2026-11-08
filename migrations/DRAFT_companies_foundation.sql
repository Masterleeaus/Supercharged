-- ============================================================
-- DRAFT - NOT FOR EXECUTION
-- This file is a draft for review only. It is NOT applied by any
-- migration runner, has NOT been run against any database, and is NOT
-- listed in migrations/meta/_journal.json. Do not add it to the automatic
-- migration sequence without review.
-- ============================================================
-- Companies foundation (tenancy decision D1, see docs/TENANCY-INVENTORY.md).
--   * Creates public.companies (UUID primary key).
--   * Adds a NULLABLE company_id uuid column and a plain index to 65 tables:
--     55 tenant tables, plus 10 ambiguous tables (users, otp_verifications,
--     synced_voices, phone_numbers, notifications, prompt_templates,
--     audit_logs, payment_webhook_queue, plivo_phone_numbers,
--     phone_release_retry_queue). NULL means platform-wide or unowned for the
--     ambiguous tables.
--   * Does NOT touch the 16 global tables or demo_sessions.
-- Additive only: no DROP, no DELETE, no UPDATE, no NOT NULL, no foreign key,
-- no RLS, no backfill. Existing rows keep company_id NULL until a later step.
-- Indexes are plain CREATE INDEX: the columns are new and empty, so there is
-- nothing to scan. D4 (CONCURRENTLY) is not decided and does not apply here.
-- Canonical creator of public.companies. DRAFT_company_scope.sql STEP 0 no longer
-- creates it and points here as the required prior step. Overlaps DRAFT_company_scope.sql
-- STEP A (same column and index names); both use IF NOT EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS users_company_id_idx ON public.users (company_id);

ALTER TABLE public.otp_verifications ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS otp_verifications_company_id_idx ON public.otp_verifications (company_id);

ALTER TABLE public.refresh_tokens ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_company_id_idx ON public.refresh_tokens (company_id);

ALTER TABLE public.synced_voices ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS synced_voices_company_id_idx ON public.synced_voices (company_id);

ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS agents_company_id_idx ON public.agents (company_id);

ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS knowledge_base_company_id_idx ON public.knowledge_base (company_id);

ALTER TABLE public.incoming_agents ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS incoming_agents_company_id_idx ON public.incoming_agents (company_id);

ALTER TABLE public.phone_numbers ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS phone_numbers_company_id_idx ON public.phone_numbers (company_id);

ALTER TABLE public.incoming_connections ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS incoming_connections_company_id_idx ON public.incoming_connections (company_id);

ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS campaigns_company_id_idx ON public.campaigns (company_id);

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON public.contacts (company_id);

ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS calls_company_id_idx ON public.calls (company_id);

ALTER TABLE public.credit_transactions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS credit_transactions_company_id_idx ON public.credit_transactions (company_id);

ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS tools_company_id_idx ON public.tools (company_id);

ALTER TABLE public.voices ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS voices_company_id_idx ON public.voices (company_id);

ALTER TABLE public.user_subscriptions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS user_subscriptions_company_id_idx ON public.user_subscriptions (company_id);

ALTER TABLE public.phone_number_rentals ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS phone_number_rentals_company_id_idx ON public.phone_number_rentals (company_id);

ALTER TABLE public.usage_records ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS usage_records_company_id_idx ON public.usage_records (company_id);

ALTER TABLE public.webhooks ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS webhooks_company_id_idx ON public.webhooks (company_id);

ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_company_id_idx ON public.webhook_deliveries (company_id);

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS notifications_company_id_idx ON public.notifications (company_id);

ALTER TABLE public.prompt_templates ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS prompt_templates_company_id_idx ON public.prompt_templates (company_id);

ALTER TABLE public.agent_versions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS agent_versions_company_id_idx ON public.agent_versions (company_id);

ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS audit_logs_company_id_idx ON public.audit_logs (company_id);

ALTER TABLE public.user_knowledge_storage_limits ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS user_knowledge_storage_limits_company_id_idx ON public.user_knowledge_storage_limits (company_id);

ALTER TABLE public.knowledge_chunks ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS knowledge_chunks_company_id_idx ON public.knowledge_chunks (company_id);

ALTER TABLE public.knowledge_processing_queue ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS knowledge_processing_queue_company_id_idx ON public.knowledge_processing_queue (company_id);

ALTER TABLE public.flows ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS flows_company_id_idx ON public.flows (company_id);

ALTER TABLE public.flow_executions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS flow_executions_company_id_idx ON public.flow_executions (company_id);

ALTER TABLE public.flow_test_queue ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS flow_test_queue_company_id_idx ON public.flow_test_queue (company_id);

ALTER TABLE public.webhook_subscriptions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS webhook_subscriptions_company_id_idx ON public.webhook_subscriptions (company_id);

ALTER TABLE public.webhook_logs ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS webhook_logs_company_id_idx ON public.webhook_logs (company_id);

ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS appointments_company_id_idx ON public.appointments (company_id);

ALTER TABLE public.appointment_settings ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS appointment_settings_company_id_idx ON public.appointment_settings (company_id);

ALTER TABLE public.forms ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS forms_company_id_idx ON public.forms (company_id);

ALTER TABLE public.form_fields ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS form_fields_company_id_idx ON public.form_fields (company_id);

ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS form_submissions_company_id_idx ON public.form_submissions (company_id);

ALTER TABLE public.payment_transactions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS payment_transactions_company_id_idx ON public.payment_transactions (company_id);

ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS refunds_company_id_idx ON public.refunds (company_id);

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS invoices_company_id_idx ON public.invoices (company_id);

ALTER TABLE public.payment_webhook_queue ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS payment_webhook_queue_company_id_idx ON public.payment_webhook_queue (company_id);

ALTER TABLE public.content_violations ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS content_violations_company_id_idx ON public.content_violations (company_id);

ALTER TABLE public.plivo_phone_numbers ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS plivo_phone_numbers_company_id_idx ON public.plivo_phone_numbers (company_id);

ALTER TABLE public.plivo_calls ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS plivo_calls_company_id_idx ON public.plivo_calls (company_id);

ALTER TABLE public.campaign_jobs ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS campaign_jobs_company_id_idx ON public.campaign_jobs (company_id);

ALTER TABLE public.user_kyc_documents ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS user_kyc_documents_company_id_idx ON public.user_kyc_documents (company_id);

ALTER TABLE public.twilio_openai_calls ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS twilio_openai_calls_company_id_idx ON public.twilio_openai_calls (company_id);

ALTER TABLE public.lead_stages ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS lead_stages_company_id_idx ON public.lead_stages (company_id);

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS leads_company_id_idx ON public.leads (company_id);

ALTER TABLE public.lead_notes ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS lead_notes_company_id_idx ON public.lead_notes (company_id);

ALTER TABLE public.lead_activities ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS lead_activities_company_id_idx ON public.lead_activities (company_id);

ALTER TABLE public.crm_category_preferences ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS crm_category_preferences_company_id_idx ON public.crm_category_preferences (company_id);

ALTER TABLE public.website_widgets ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS website_widgets_company_id_idx ON public.website_widgets (company_id);

ALTER TABLE public.widget_call_sessions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS widget_call_sessions_company_id_idx ON public.widget_call_sessions (company_id);

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS api_keys_company_id_idx ON public.api_keys (company_id);

ALTER TABLE public.api_audit_logs ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS api_audit_logs_company_id_idx ON public.api_audit_logs (company_id);

ALTER TABLE public.api_rate_limits ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS api_rate_limits_company_id_idx ON public.api_rate_limits (company_id);

ALTER TABLE public.sip_trunks ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS sip_trunks_company_id_idx ON public.sip_trunks (company_id);

ALTER TABLE public.sip_phone_numbers ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS sip_phone_numbers_company_id_idx ON public.sip_phone_numbers (company_id);

ALTER TABLE public.sip_calls ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS sip_calls_company_id_idx ON public.sip_calls (company_id);

ALTER TABLE public.user_addresses ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS user_addresses_company_id_idx ON public.user_addresses (company_id);

ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS user_feedback_company_id_idx ON public.user_feedback (company_id);

ALTER TABLE public.google_calendar_credentials ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS google_calendar_credentials_company_id_idx ON public.google_calendar_credentials (company_id);

ALTER TABLE public.google_sheets_credentials ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS google_sheets_credentials_company_id_idx ON public.google_sheets_credentials (company_id);

ALTER TABLE public.phone_release_retry_queue ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX IF NOT EXISTS phone_release_retry_queue_company_id_idx ON public.phone_release_retry_queue (company_id);
