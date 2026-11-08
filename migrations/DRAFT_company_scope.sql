-- ============================================================================
-- DRAFT: NOT FOR EXECUTION
--
-- This file is a design draft for company (tenant) scoping in Desk.
--   * It is NOT in the scripts/run-safe-migration.mjs list and must not be
--     added to it until the migration plan in docs/TENANCY.md is approved.
--   * It does NOT add company_id columns to any live table.
--   * Sections 4 and 5 draft the company_id migration (TENANCY.md steps 2, 3, 6).
--     Tenant tables are listed in docs/TENANCY-INVENTORY.md. Ambiguous and
--     global tables are not touched. Open decisions and blockers are in that file.
--   * The example table below does not exist. Replace it in the real pass.
--   * The password for desk_app is a placeholder. It must be set outside
--     migrations (ALTER ROLE ... PASSWORD, from a secrets manager). Never commit
--     a real password to this repository.
-- ============================================================================

-- GUARD: stops any accidental run of this whole file. Remove only in the approved pass.
DO $$ BEGIN RAISE EXCEPTION 'DRAFT_company_scope.sql must not be executed; see docs/TENANCY.md'; END $$;

-- 1. Restricted application role ------------------------------------------
--
-- withTenant() runs SET LOCAL ROLE desk_app for every tenant transaction.
-- desk_app must:
--   * not own any table (owners are not forced into policies by default),
--   * not be a superuser, and not have BYPASSRLS.
--
-- The login role the app connects with must be a member of desk_app so that
-- SET LOCAL ROLE is allowed:  GRANT desk_app TO <app_login_role>;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'desk_app') THEN
    -- PLACEHOLDER password. Replace out-of-band; do not run this as-is.
    CREATE ROLE desk_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
      PASSWORD 'REPLACE_OUT_OF_BAND_NOT_IN_MIGRATIONS';
  END IF;
END
$$;

-- Re-assert the attributes even if the role already existed.
ALTER ROLE desk_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- 2. Current-company function ---------------------------------------------
--
-- Reads the transaction-local setting written by withTenant(). When the
-- setting was never set, current_setting(..., true) returns NULL. When it was
-- set and the transaction ended, it reads back as ''. nullif() turns '' into
-- NULL, so the comparison matches zero rows instead of raising an error for
-- ''::uuid.

CREATE OR REPLACE FUNCTION public.current_company_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;

-- 3. Policy pattern (example table) ---------------------------------------
--
-- Pattern to repeat for each scoped table. The table and its company_id
-- column are placeholders.

-- CREATE TABLE public.example_tenant_table (   -- placeholder, does not exist
--   id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   company_id uuid NOT NULL,
--   name       text NOT NULL
-- );

-- ALTER TABLE public.example_tenant_table ENABLE ROW LEVEL SECURITY;
-- -- FORCE makes the policy apply to the table owner too. Without it, a
-- -- connection that owns the table bypasses RLS entirely.
-- ALTER TABLE public.example_tenant_table FORCE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS example_tenant_table_company_isolation
--   ON public.example_tenant_table;
-- CREATE POLICY example_tenant_table_company_isolation
--   ON public.example_tenant_table
--   AS PERMISSIVE
--   FOR ALL
--   TO desk_app
--   USING (company_id = public.current_company_id())
--   WITH CHECK (company_id = public.current_company_id());
--
-- -- Grants for the restricted role only. No grant to PUBLIC.
-- GRANT USAGE ON SCHEMA public TO desk_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.example_tenant_table TO desk_app;
-- GRANT EXECUTE ON FUNCTION public.current_company_id() TO desk_app;

-- 4. Company id source (BLOCKED, D1) ----------------------------------------
-- ==== STEP 0: companies table (FK target). Created ONLY in the prerequisite draft.
-- REQUIRED PRIOR STEP: migrations/DRAFT_companies_foundation.sql is the single
-- canonical creation of public.companies. Review and apply it before any step
-- in this file. It is not repeated here, so do not add a second CREATE TABLE.
-- The id source and the users.company mapping are still undecided (D1).

-- 5. Column, index, backfill, FK and NOT NULL, per tenant table ------------
-- The step order is A, B, C, D. Do not run a later step before the one before it
-- has been reviewed and its check is clean.

-- ==== STEP A (TENANCY.md step 2): add nullable company_id, index. Additive.
-- Index is CONCURRENTLY: it must run outside a transaction block.
-- users.company_id is NOT added here. It is now RESOLVED as a nullable uuid column
-- in the prerequisite draft migrations/DRAFT_companies_foundation.sql, which adds it
-- without a foreign key to companies. The FK is still NOT added (deliberate, to keep
-- the draft additive). Its value source (the D1 mapping) is still open, so the
-- backfill in STEP B stays blocked. See docs/TENANCY-INVENTORY.md.
ALTER TABLE public.refresh_tokens ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS refresh_tokens_company_id_idx ON public.refresh_tokens (company_id);
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS agents_company_id_idx ON public.agents (company_id);
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_base_company_id_idx ON public.knowledge_base (company_id);
ALTER TABLE public.incoming_agents ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS incoming_agents_company_id_idx ON public.incoming_agents (company_id);
ALTER TABLE public.incoming_connections ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS incoming_connections_company_id_idx ON public.incoming_connections (company_id);
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaigns_company_id_idx ON public.campaigns (company_id);
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_company_id_idx ON public.contacts (company_id);
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS calls_company_id_idx ON public.calls (company_id);
ALTER TABLE public.credit_transactions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS credit_transactions_company_id_idx ON public.credit_transactions (company_id);
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS tools_company_id_idx ON public.tools (company_id);
ALTER TABLE public.voices ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS voices_company_id_idx ON public.voices (company_id);
ALTER TABLE public.user_subscriptions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_subscriptions_company_id_idx ON public.user_subscriptions (company_id);
ALTER TABLE public.phone_number_rentals ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS phone_number_rentals_company_id_idx ON public.phone_number_rentals (company_id);
ALTER TABLE public.usage_records ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_records_company_id_idx ON public.usage_records (company_id);
ALTER TABLE public.webhooks ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS webhooks_company_id_idx ON public.webhooks (company_id);
ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_deliveries_company_id_idx ON public.webhook_deliveries (company_id);
ALTER TABLE public.agent_versions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_versions_company_id_idx ON public.agent_versions (company_id);
ALTER TABLE public.user_knowledge_storage_limits ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_knowledge_storage_limits_company_id_idx ON public.user_knowledge_storage_limits (company_id);
ALTER TABLE public.knowledge_chunks ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_chunks_company_id_idx ON public.knowledge_chunks (company_id);
ALTER TABLE public.knowledge_processing_queue ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS knowledge_processing_queue_company_id_idx ON public.knowledge_processing_queue (company_id);
ALTER TABLE public.flows ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS flows_company_id_idx ON public.flows (company_id);
ALTER TABLE public.flow_executions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_executions_company_id_idx ON public.flow_executions (company_id);
ALTER TABLE public.flow_test_queue ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_test_queue_company_id_idx ON public.flow_test_queue (company_id);
ALTER TABLE public.webhook_subscriptions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_subscriptions_company_id_idx ON public.webhook_subscriptions (company_id);
ALTER TABLE public.webhook_logs ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_logs_company_id_idx ON public.webhook_logs (company_id);
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS appointments_company_id_idx ON public.appointments (company_id);
ALTER TABLE public.appointment_settings ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS appointment_settings_company_id_idx ON public.appointment_settings (company_id);
ALTER TABLE public.forms ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS forms_company_id_idx ON public.forms (company_id);
ALTER TABLE public.form_fields ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS form_fields_company_id_idx ON public.form_fields (company_id);
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS form_submissions_company_id_idx ON public.form_submissions (company_id);
ALTER TABLE public.payment_transactions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS payment_transactions_company_id_idx ON public.payment_transactions (company_id);
ALTER TABLE public.refunds ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS refunds_company_id_idx ON public.refunds (company_id);
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS invoices_company_id_idx ON public.invoices (company_id);
ALTER TABLE public.content_violations ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS content_violations_company_id_idx ON public.content_violations (company_id);
ALTER TABLE public.plivo_calls ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS plivo_calls_company_id_idx ON public.plivo_calls (company_id);
ALTER TABLE public.campaign_jobs ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS campaign_jobs_company_id_idx ON public.campaign_jobs (company_id);
ALTER TABLE public.user_kyc_documents ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_kyc_documents_company_id_idx ON public.user_kyc_documents (company_id);
ALTER TABLE public.twilio_openai_calls ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS twilio_openai_calls_company_id_idx ON public.twilio_openai_calls (company_id);
ALTER TABLE public.lead_stages ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS lead_stages_company_id_idx ON public.lead_stages (company_id);
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS leads_company_id_idx ON public.leads (company_id);
ALTER TABLE public.lead_notes ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS lead_notes_company_id_idx ON public.lead_notes (company_id);
ALTER TABLE public.lead_activities ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS lead_activities_company_id_idx ON public.lead_activities (company_id);
ALTER TABLE public.crm_category_preferences ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_category_preferences_company_id_idx ON public.crm_category_preferences (company_id);
ALTER TABLE public.website_widgets ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS website_widgets_company_id_idx ON public.website_widgets (company_id);
ALTER TABLE public.widget_call_sessions ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS widget_call_sessions_company_id_idx ON public.widget_call_sessions (company_id);
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS api_keys_company_id_idx ON public.api_keys (company_id);
ALTER TABLE public.api_audit_logs ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS api_audit_logs_company_id_idx ON public.api_audit_logs (company_id);
ALTER TABLE public.api_rate_limits ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS api_rate_limits_company_id_idx ON public.api_rate_limits (company_id);
ALTER TABLE public.sip_trunks ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS sip_trunks_company_id_idx ON public.sip_trunks (company_id);
ALTER TABLE public.sip_phone_numbers ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS sip_phone_numbers_company_id_idx ON public.sip_phone_numbers (company_id);
ALTER TABLE public.sip_calls ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS sip_calls_company_id_idx ON public.sip_calls (company_id);
ALTER TABLE public.user_addresses ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_addresses_company_id_idx ON public.user_addresses (company_id);
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_feedback_company_id_idx ON public.user_feedback (company_id);
ALTER TABLE public.google_calendar_credentials ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS google_calendar_credentials_company_id_idx ON public.google_calendar_credentials (company_id);
ALTER TABLE public.google_sheets_credentials ADD COLUMN IF NOT EXISTS company_id uuid NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS google_sheets_credentials_company_id_idx ON public.google_sheets_credentials (company_id);

-- ==== STEP B (TENANCY.md step 3): backfill from the owning parent row.
-- BLOCKED on D1: every statement reads users.company_id, which has no source yet.
-- Parents are filled before children. Each UPDATE only touches NULL rows, so it can be re-run.
-- B1: parent is users (user_id).
UPDATE public.refresh_tokens AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.agents AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.knowledge_base AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.incoming_agents AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.incoming_connections AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.campaigns AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.credit_transactions AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.tools AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.voices AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.user_subscriptions AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.phone_number_rentals AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.usage_records AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.webhooks AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.user_knowledge_storage_limits AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.knowledge_chunks AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.knowledge_processing_queue AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.flows AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.flow_test_queue AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.webhook_subscriptions AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.appointments AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.appointment_settings AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.forms AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.payment_transactions AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.refunds AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.invoices AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.content_violations AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.user_kyc_documents AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.lead_stages AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.leads AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.lead_notes AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.lead_activities AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.crm_category_preferences AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.website_widgets AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.widget_call_sessions AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.api_keys AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.api_audit_logs AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.sip_trunks AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.sip_phone_numbers AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.sip_calls AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.user_addresses AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.user_feedback AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.google_calendar_credentials AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.google_sheets_credentials AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
-- B2: child tables and tables with fallback parents. Run after B1.
UPDATE public.contacts AS t SET company_id = p.company_id FROM public.campaigns AS p WHERE t.campaign_id = p.id AND t.company_id IS NULL;
UPDATE public.calls AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.calls AS t SET company_id = p.company_id FROM public.campaigns AS p WHERE t.campaign_id = p.id AND t.company_id IS NULL;
UPDATE public.calls AS t SET company_id = p.company_id FROM public.incoming_connections AS p WHERE t.incoming_connection_id = p.id AND t.company_id IS NULL;
UPDATE public.calls AS t SET company_id = p.company_id FROM public.website_widgets AS p WHERE t.widget_id = p.id AND t.company_id IS NULL;
UPDATE public.webhook_deliveries AS t SET company_id = p.company_id FROM public.webhooks AS p WHERE t.webhook_id = p.id AND t.company_id IS NULL;
UPDATE public.agent_versions AS t SET company_id = p.company_id FROM public.agents AS p WHERE t.agent_id = p.id AND t.company_id IS NULL;
UPDATE public.flow_executions AS t SET company_id = p.company_id FROM public.flows AS p WHERE t.flow_id = p.id AND t.company_id IS NULL;
UPDATE public.webhook_logs AS t SET company_id = p.company_id FROM public.webhook_subscriptions AS p WHERE t.webhook_id = p.id AND t.company_id IS NULL;
UPDATE public.form_fields AS t SET company_id = p.company_id FROM public.forms AS p WHERE t.form_id = p.id AND t.company_id IS NULL;
UPDATE public.form_submissions AS t SET company_id = p.company_id FROM public.forms AS p WHERE t.form_id = p.id AND t.company_id IS NULL;
UPDATE public.plivo_calls AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.plivo_calls AS t SET company_id = p.company_id FROM public.campaigns AS p WHERE t.campaign_id = p.id AND t.company_id IS NULL;
UPDATE public.plivo_calls AS t SET company_id = p.company_id FROM public.agents AS p WHERE t.agent_id = p.id AND t.company_id IS NULL;
UPDATE public.campaign_jobs AS t SET company_id = p.company_id FROM public.campaigns AS p WHERE t.campaign_id = p.id AND t.company_id IS NULL;
UPDATE public.twilio_openai_calls AS t SET company_id = p.company_id FROM public.users AS p WHERE t.user_id = p.id AND t.company_id IS NULL;
UPDATE public.twilio_openai_calls AS t SET company_id = p.company_id FROM public.campaigns AS p WHERE t.campaign_id = p.id AND t.company_id IS NULL;
UPDATE public.twilio_openai_calls AS t SET company_id = p.company_id FROM public.agents AS p WHERE t.agent_id = p.id AND t.company_id IS NULL;
UPDATE public.api_rate_limits AS t SET company_id = p.company_id FROM public.api_keys AS p WHERE t.api_key_id = p.id AND t.company_id IS NULL;
-- B3: orphan report. Every row listed here has no resolvable parent and must be decided before step C.
SELECT table_name, null_rows FROM (
  SELECT 'refresh_tokens' AS table_name, count(*) AS null_rows FROM public.refresh_tokens WHERE company_id IS NULL
UNION ALL
  SELECT 'agents' AS table_name, count(*) AS null_rows FROM public.agents WHERE company_id IS NULL
UNION ALL
  SELECT 'knowledge_base' AS table_name, count(*) AS null_rows FROM public.knowledge_base WHERE company_id IS NULL
UNION ALL
  SELECT 'incoming_agents' AS table_name, count(*) AS null_rows FROM public.incoming_agents WHERE company_id IS NULL
UNION ALL
  SELECT 'incoming_connections' AS table_name, count(*) AS null_rows FROM public.incoming_connections WHERE company_id IS NULL
UNION ALL
  SELECT 'campaigns' AS table_name, count(*) AS null_rows FROM public.campaigns WHERE company_id IS NULL
UNION ALL
  SELECT 'contacts' AS table_name, count(*) AS null_rows FROM public.contacts WHERE company_id IS NULL
UNION ALL
  SELECT 'calls' AS table_name, count(*) AS null_rows FROM public.calls WHERE company_id IS NULL
UNION ALL
  SELECT 'credit_transactions' AS table_name, count(*) AS null_rows FROM public.credit_transactions WHERE company_id IS NULL
UNION ALL
  SELECT 'tools' AS table_name, count(*) AS null_rows FROM public.tools WHERE company_id IS NULL
UNION ALL
  SELECT 'voices' AS table_name, count(*) AS null_rows FROM public.voices WHERE company_id IS NULL
UNION ALL
  SELECT 'user_subscriptions' AS table_name, count(*) AS null_rows FROM public.user_subscriptions WHERE company_id IS NULL
UNION ALL
  SELECT 'phone_number_rentals' AS table_name, count(*) AS null_rows FROM public.phone_number_rentals WHERE company_id IS NULL
UNION ALL
  SELECT 'usage_records' AS table_name, count(*) AS null_rows FROM public.usage_records WHERE company_id IS NULL
UNION ALL
  SELECT 'webhooks' AS table_name, count(*) AS null_rows FROM public.webhooks WHERE company_id IS NULL
UNION ALL
  SELECT 'webhook_deliveries' AS table_name, count(*) AS null_rows FROM public.webhook_deliveries WHERE company_id IS NULL
UNION ALL
  SELECT 'agent_versions' AS table_name, count(*) AS null_rows FROM public.agent_versions WHERE company_id IS NULL
UNION ALL
  SELECT 'user_knowledge_storage_limits' AS table_name, count(*) AS null_rows FROM public.user_knowledge_storage_limits WHERE company_id IS NULL
UNION ALL
  SELECT 'knowledge_chunks' AS table_name, count(*) AS null_rows FROM public.knowledge_chunks WHERE company_id IS NULL
UNION ALL
  SELECT 'knowledge_processing_queue' AS table_name, count(*) AS null_rows FROM public.knowledge_processing_queue WHERE company_id IS NULL
UNION ALL
  SELECT 'flows' AS table_name, count(*) AS null_rows FROM public.flows WHERE company_id IS NULL
UNION ALL
  SELECT 'flow_executions' AS table_name, count(*) AS null_rows FROM public.flow_executions WHERE company_id IS NULL
UNION ALL
  SELECT 'flow_test_queue' AS table_name, count(*) AS null_rows FROM public.flow_test_queue WHERE company_id IS NULL
UNION ALL
  SELECT 'webhook_subscriptions' AS table_name, count(*) AS null_rows FROM public.webhook_subscriptions WHERE company_id IS NULL
UNION ALL
  SELECT 'webhook_logs' AS table_name, count(*) AS null_rows FROM public.webhook_logs WHERE company_id IS NULL
UNION ALL
  SELECT 'appointments' AS table_name, count(*) AS null_rows FROM public.appointments WHERE company_id IS NULL
UNION ALL
  SELECT 'appointment_settings' AS table_name, count(*) AS null_rows FROM public.appointment_settings WHERE company_id IS NULL
UNION ALL
  SELECT 'forms' AS table_name, count(*) AS null_rows FROM public.forms WHERE company_id IS NULL
UNION ALL
  SELECT 'form_fields' AS table_name, count(*) AS null_rows FROM public.form_fields WHERE company_id IS NULL
UNION ALL
  SELECT 'form_submissions' AS table_name, count(*) AS null_rows FROM public.form_submissions WHERE company_id IS NULL
UNION ALL
  SELECT 'payment_transactions' AS table_name, count(*) AS null_rows FROM public.payment_transactions WHERE company_id IS NULL
UNION ALL
  SELECT 'refunds' AS table_name, count(*) AS null_rows FROM public.refunds WHERE company_id IS NULL
UNION ALL
  SELECT 'invoices' AS table_name, count(*) AS null_rows FROM public.invoices WHERE company_id IS NULL
UNION ALL
  SELECT 'content_violations' AS table_name, count(*) AS null_rows FROM public.content_violations WHERE company_id IS NULL
UNION ALL
  SELECT 'plivo_calls' AS table_name, count(*) AS null_rows FROM public.plivo_calls WHERE company_id IS NULL
UNION ALL
  SELECT 'campaign_jobs' AS table_name, count(*) AS null_rows FROM public.campaign_jobs WHERE company_id IS NULL
UNION ALL
  SELECT 'user_kyc_documents' AS table_name, count(*) AS null_rows FROM public.user_kyc_documents WHERE company_id IS NULL
UNION ALL
  SELECT 'twilio_openai_calls' AS table_name, count(*) AS null_rows FROM public.twilio_openai_calls WHERE company_id IS NULL
UNION ALL
  SELECT 'lead_stages' AS table_name, count(*) AS null_rows FROM public.lead_stages WHERE company_id IS NULL
UNION ALL
  SELECT 'leads' AS table_name, count(*) AS null_rows FROM public.leads WHERE company_id IS NULL
UNION ALL
  SELECT 'lead_notes' AS table_name, count(*) AS null_rows FROM public.lead_notes WHERE company_id IS NULL
UNION ALL
  SELECT 'lead_activities' AS table_name, count(*) AS null_rows FROM public.lead_activities WHERE company_id IS NULL
UNION ALL
  SELECT 'crm_category_preferences' AS table_name, count(*) AS null_rows FROM public.crm_category_preferences WHERE company_id IS NULL
UNION ALL
  SELECT 'website_widgets' AS table_name, count(*) AS null_rows FROM public.website_widgets WHERE company_id IS NULL
UNION ALL
  SELECT 'widget_call_sessions' AS table_name, count(*) AS null_rows FROM public.widget_call_sessions WHERE company_id IS NULL
UNION ALL
  SELECT 'api_keys' AS table_name, count(*) AS null_rows FROM public.api_keys WHERE company_id IS NULL
UNION ALL
  SELECT 'api_audit_logs' AS table_name, count(*) AS null_rows FROM public.api_audit_logs WHERE company_id IS NULL
UNION ALL
  SELECT 'api_rate_limits' AS table_name, count(*) AS null_rows FROM public.api_rate_limits WHERE company_id IS NULL
UNION ALL
  SELECT 'sip_trunks' AS table_name, count(*) AS null_rows FROM public.sip_trunks WHERE company_id IS NULL
UNION ALL
  SELECT 'sip_phone_numbers' AS table_name, count(*) AS null_rows FROM public.sip_phone_numbers WHERE company_id IS NULL
UNION ALL
  SELECT 'sip_calls' AS table_name, count(*) AS null_rows FROM public.sip_calls WHERE company_id IS NULL
UNION ALL
  SELECT 'user_addresses' AS table_name, count(*) AS null_rows FROM public.user_addresses WHERE company_id IS NULL
UNION ALL
  SELECT 'user_feedback' AS table_name, count(*) AS null_rows FROM public.user_feedback WHERE company_id IS NULL
UNION ALL
  SELECT 'google_calendar_credentials' AS table_name, count(*) AS null_rows FROM public.google_calendar_credentials WHERE company_id IS NULL
UNION ALL
  SELECT 'google_sheets_credentials' AS table_name, count(*) AS null_rows FROM public.google_sheets_credentials WHERE company_id IS NULL
) AS orphans WHERE null_rows > 0 ORDER BY null_rows DESC;

-- ==== STEP C (TENANCY.md step 6, part 1): foreign key to companies. NOT VALID, then VALIDATE, so the lock is short.
-- Needs public.companies (Step 0). BLOCKED on D1.
ALTER TABLE public.refresh_tokens ADD CONSTRAINT refresh_tokens_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.refresh_tokens VALIDATE CONSTRAINT refresh_tokens_company_id_fkey;
ALTER TABLE public.agents ADD CONSTRAINT agents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.agents VALIDATE CONSTRAINT agents_company_id_fkey;
ALTER TABLE public.knowledge_base ADD CONSTRAINT knowledge_base_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.knowledge_base VALIDATE CONSTRAINT knowledge_base_company_id_fkey;
ALTER TABLE public.incoming_agents ADD CONSTRAINT incoming_agents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.incoming_agents VALIDATE CONSTRAINT incoming_agents_company_id_fkey;
ALTER TABLE public.incoming_connections ADD CONSTRAINT incoming_connections_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.incoming_connections VALIDATE CONSTRAINT incoming_connections_company_id_fkey;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.campaigns VALIDATE CONSTRAINT campaigns_company_id_fkey;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.contacts VALIDATE CONSTRAINT contacts_company_id_fkey;
ALTER TABLE public.calls ADD CONSTRAINT calls_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.calls VALIDATE CONSTRAINT calls_company_id_fkey;
ALTER TABLE public.credit_transactions ADD CONSTRAINT credit_transactions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.credit_transactions VALIDATE CONSTRAINT credit_transactions_company_id_fkey;
ALTER TABLE public.tools ADD CONSTRAINT tools_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.tools VALIDATE CONSTRAINT tools_company_id_fkey;
ALTER TABLE public.voices ADD CONSTRAINT voices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.voices VALIDATE CONSTRAINT voices_company_id_fkey;
ALTER TABLE public.user_subscriptions ADD CONSTRAINT user_subscriptions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.user_subscriptions VALIDATE CONSTRAINT user_subscriptions_company_id_fkey;
ALTER TABLE public.phone_number_rentals ADD CONSTRAINT phone_number_rentals_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.phone_number_rentals VALIDATE CONSTRAINT phone_number_rentals_company_id_fkey;
ALTER TABLE public.usage_records ADD CONSTRAINT usage_records_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.usage_records VALIDATE CONSTRAINT usage_records_company_id_fkey;
ALTER TABLE public.webhooks ADD CONSTRAINT webhooks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.webhooks VALIDATE CONSTRAINT webhooks_company_id_fkey;
ALTER TABLE public.webhook_deliveries ADD CONSTRAINT webhook_deliveries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.webhook_deliveries VALIDATE CONSTRAINT webhook_deliveries_company_id_fkey;
ALTER TABLE public.agent_versions ADD CONSTRAINT agent_versions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.agent_versions VALIDATE CONSTRAINT agent_versions_company_id_fkey;
ALTER TABLE public.user_knowledge_storage_limits ADD CONSTRAINT user_knowledge_storage_limits_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.user_knowledge_storage_limits VALIDATE CONSTRAINT user_knowledge_storage_limits_company_id_fkey;
ALTER TABLE public.knowledge_chunks ADD CONSTRAINT knowledge_chunks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.knowledge_chunks VALIDATE CONSTRAINT knowledge_chunks_company_id_fkey;
ALTER TABLE public.knowledge_processing_queue ADD CONSTRAINT knowledge_processing_queue_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.knowledge_processing_queue VALIDATE CONSTRAINT knowledge_processing_queue_company_id_fkey;
ALTER TABLE public.flows ADD CONSTRAINT flows_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.flows VALIDATE CONSTRAINT flows_company_id_fkey;
ALTER TABLE public.flow_executions ADD CONSTRAINT flow_executions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.flow_executions VALIDATE CONSTRAINT flow_executions_company_id_fkey;
ALTER TABLE public.flow_test_queue ADD CONSTRAINT flow_test_queue_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.flow_test_queue VALIDATE CONSTRAINT flow_test_queue_company_id_fkey;
ALTER TABLE public.webhook_subscriptions ADD CONSTRAINT webhook_subscriptions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.webhook_subscriptions VALIDATE CONSTRAINT webhook_subscriptions_company_id_fkey;
ALTER TABLE public.webhook_logs ADD CONSTRAINT webhook_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.webhook_logs VALIDATE CONSTRAINT webhook_logs_company_id_fkey;
ALTER TABLE public.appointments ADD CONSTRAINT appointments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.appointments VALIDATE CONSTRAINT appointments_company_id_fkey;
ALTER TABLE public.appointment_settings ADD CONSTRAINT appointment_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.appointment_settings VALIDATE CONSTRAINT appointment_settings_company_id_fkey;
ALTER TABLE public.forms ADD CONSTRAINT forms_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.forms VALIDATE CONSTRAINT forms_company_id_fkey;
ALTER TABLE public.form_fields ADD CONSTRAINT form_fields_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.form_fields VALIDATE CONSTRAINT form_fields_company_id_fkey;
ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.form_submissions VALIDATE CONSTRAINT form_submissions_company_id_fkey;
ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.payment_transactions VALIDATE CONSTRAINT payment_transactions_company_id_fkey;
ALTER TABLE public.refunds ADD CONSTRAINT refunds_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.refunds VALIDATE CONSTRAINT refunds_company_id_fkey;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.invoices VALIDATE CONSTRAINT invoices_company_id_fkey;
ALTER TABLE public.content_violations ADD CONSTRAINT content_violations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.content_violations VALIDATE CONSTRAINT content_violations_company_id_fkey;
ALTER TABLE public.plivo_calls ADD CONSTRAINT plivo_calls_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.plivo_calls VALIDATE CONSTRAINT plivo_calls_company_id_fkey;
ALTER TABLE public.campaign_jobs ADD CONSTRAINT campaign_jobs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.campaign_jobs VALIDATE CONSTRAINT campaign_jobs_company_id_fkey;
ALTER TABLE public.user_kyc_documents ADD CONSTRAINT user_kyc_documents_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.user_kyc_documents VALIDATE CONSTRAINT user_kyc_documents_company_id_fkey;
ALTER TABLE public.twilio_openai_calls ADD CONSTRAINT twilio_openai_calls_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.twilio_openai_calls VALIDATE CONSTRAINT twilio_openai_calls_company_id_fkey;
ALTER TABLE public.lead_stages ADD CONSTRAINT lead_stages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.lead_stages VALIDATE CONSTRAINT lead_stages_company_id_fkey;
ALTER TABLE public.leads ADD CONSTRAINT leads_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.leads VALIDATE CONSTRAINT leads_company_id_fkey;
ALTER TABLE public.lead_notes ADD CONSTRAINT lead_notes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.lead_notes VALIDATE CONSTRAINT lead_notes_company_id_fkey;
ALTER TABLE public.lead_activities ADD CONSTRAINT lead_activities_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.lead_activities VALIDATE CONSTRAINT lead_activities_company_id_fkey;
ALTER TABLE public.crm_category_preferences ADD CONSTRAINT crm_category_preferences_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.crm_category_preferences VALIDATE CONSTRAINT crm_category_preferences_company_id_fkey;
ALTER TABLE public.website_widgets ADD CONSTRAINT website_widgets_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.website_widgets VALIDATE CONSTRAINT website_widgets_company_id_fkey;
ALTER TABLE public.widget_call_sessions ADD CONSTRAINT widget_call_sessions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.widget_call_sessions VALIDATE CONSTRAINT widget_call_sessions_company_id_fkey;
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.api_keys VALIDATE CONSTRAINT api_keys_company_id_fkey;
ALTER TABLE public.api_audit_logs ADD CONSTRAINT api_audit_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.api_audit_logs VALIDATE CONSTRAINT api_audit_logs_company_id_fkey;
ALTER TABLE public.api_rate_limits ADD CONSTRAINT api_rate_limits_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.api_rate_limits VALIDATE CONSTRAINT api_rate_limits_company_id_fkey;
ALTER TABLE public.sip_trunks ADD CONSTRAINT sip_trunks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.sip_trunks VALIDATE CONSTRAINT sip_trunks_company_id_fkey;
ALTER TABLE public.sip_phone_numbers ADD CONSTRAINT sip_phone_numbers_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.sip_phone_numbers VALIDATE CONSTRAINT sip_phone_numbers_company_id_fkey;
ALTER TABLE public.sip_calls ADD CONSTRAINT sip_calls_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.sip_calls VALIDATE CONSTRAINT sip_calls_company_id_fkey;
ALTER TABLE public.user_addresses ADD CONSTRAINT user_addresses_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.user_addresses VALIDATE CONSTRAINT user_addresses_company_id_fkey;
ALTER TABLE public.user_feedback ADD CONSTRAINT user_feedback_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.user_feedback VALIDATE CONSTRAINT user_feedback_company_id_fkey;
ALTER TABLE public.google_calendar_credentials ADD CONSTRAINT google_calendar_credentials_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.google_calendar_credentials VALIDATE CONSTRAINT google_calendar_credentials_company_id_fkey;
ALTER TABLE public.google_sheets_credentials ADD CONSTRAINT google_sheets_credentials_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies (id) NOT VALID;
ALTER TABLE public.google_sheets_credentials VALIDATE CONSTRAINT google_sheets_credentials_company_id_fkey;

-- ==== STEP D (TENANCY.md step 6, part 2): NOT NULL. Separate review, later window.
-- Each table is guarded: the DO block stops the step if any NULL row remains.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.refresh_tokens WHERE company_id IS NULL) THEN RAISE EXCEPTION 'refresh_tokens: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.refresh_tokens ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.agents WHERE company_id IS NULL) THEN RAISE EXCEPTION 'agents: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.agents ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.knowledge_base WHERE company_id IS NULL) THEN RAISE EXCEPTION 'knowledge_base: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.knowledge_base ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.incoming_agents WHERE company_id IS NULL) THEN RAISE EXCEPTION 'incoming_agents: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.incoming_agents ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.incoming_connections WHERE company_id IS NULL) THEN RAISE EXCEPTION 'incoming_connections: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.incoming_connections ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.campaigns WHERE company_id IS NULL) THEN RAISE EXCEPTION 'campaigns: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.campaigns ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.contacts WHERE company_id IS NULL) THEN RAISE EXCEPTION 'contacts: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.contacts ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.calls WHERE company_id IS NULL) THEN RAISE EXCEPTION 'calls: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.calls ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.credit_transactions WHERE company_id IS NULL) THEN RAISE EXCEPTION 'credit_transactions: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.credit_transactions ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.tools WHERE company_id IS NULL) THEN RAISE EXCEPTION 'tools: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.tools ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.voices WHERE company_id IS NULL) THEN RAISE EXCEPTION 'voices: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.voices ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.user_subscriptions WHERE company_id IS NULL) THEN RAISE EXCEPTION 'user_subscriptions: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.user_subscriptions ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.phone_number_rentals WHERE company_id IS NULL) THEN RAISE EXCEPTION 'phone_number_rentals: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.phone_number_rentals ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.usage_records WHERE company_id IS NULL) THEN RAISE EXCEPTION 'usage_records: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.usage_records ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.webhooks WHERE company_id IS NULL) THEN RAISE EXCEPTION 'webhooks: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.webhooks ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.webhook_deliveries WHERE company_id IS NULL) THEN RAISE EXCEPTION 'webhook_deliveries: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.webhook_deliveries ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.agent_versions WHERE company_id IS NULL) THEN RAISE EXCEPTION 'agent_versions: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.agent_versions ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.user_knowledge_storage_limits WHERE company_id IS NULL) THEN RAISE EXCEPTION 'user_knowledge_storage_limits: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.user_knowledge_storage_limits ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.knowledge_chunks WHERE company_id IS NULL) THEN RAISE EXCEPTION 'knowledge_chunks: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.knowledge_chunks ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.knowledge_processing_queue WHERE company_id IS NULL) THEN RAISE EXCEPTION 'knowledge_processing_queue: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.knowledge_processing_queue ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.flows WHERE company_id IS NULL) THEN RAISE EXCEPTION 'flows: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.flows ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.flow_executions WHERE company_id IS NULL) THEN RAISE EXCEPTION 'flow_executions: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.flow_executions ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.flow_test_queue WHERE company_id IS NULL) THEN RAISE EXCEPTION 'flow_test_queue: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.flow_test_queue ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.webhook_subscriptions WHERE company_id IS NULL) THEN RAISE EXCEPTION 'webhook_subscriptions: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.webhook_subscriptions ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.webhook_logs WHERE company_id IS NULL) THEN RAISE EXCEPTION 'webhook_logs: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.webhook_logs ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.appointments WHERE company_id IS NULL) THEN RAISE EXCEPTION 'appointments: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.appointments ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.appointment_settings WHERE company_id IS NULL) THEN RAISE EXCEPTION 'appointment_settings: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.appointment_settings ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.forms WHERE company_id IS NULL) THEN RAISE EXCEPTION 'forms: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.forms ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.form_fields WHERE company_id IS NULL) THEN RAISE EXCEPTION 'form_fields: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.form_fields ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.form_submissions WHERE company_id IS NULL) THEN RAISE EXCEPTION 'form_submissions: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.form_submissions ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.payment_transactions WHERE company_id IS NULL) THEN RAISE EXCEPTION 'payment_transactions: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.payment_transactions ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.refunds WHERE company_id IS NULL) THEN RAISE EXCEPTION 'refunds: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.refunds ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.invoices WHERE company_id IS NULL) THEN RAISE EXCEPTION 'invoices: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.invoices ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.content_violations WHERE company_id IS NULL) THEN RAISE EXCEPTION 'content_violations: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.content_violations ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.plivo_calls WHERE company_id IS NULL) THEN RAISE EXCEPTION 'plivo_calls: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.plivo_calls ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.campaign_jobs WHERE company_id IS NULL) THEN RAISE EXCEPTION 'campaign_jobs: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.campaign_jobs ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.user_kyc_documents WHERE company_id IS NULL) THEN RAISE EXCEPTION 'user_kyc_documents: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.user_kyc_documents ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.twilio_openai_calls WHERE company_id IS NULL) THEN RAISE EXCEPTION 'twilio_openai_calls: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.twilio_openai_calls ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.lead_stages WHERE company_id IS NULL) THEN RAISE EXCEPTION 'lead_stages: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.lead_stages ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.leads WHERE company_id IS NULL) THEN RAISE EXCEPTION 'leads: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.leads ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.lead_notes WHERE company_id IS NULL) THEN RAISE EXCEPTION 'lead_notes: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.lead_notes ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.lead_activities WHERE company_id IS NULL) THEN RAISE EXCEPTION 'lead_activities: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.lead_activities ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.crm_category_preferences WHERE company_id IS NULL) THEN RAISE EXCEPTION 'crm_category_preferences: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.crm_category_preferences ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.website_widgets WHERE company_id IS NULL) THEN RAISE EXCEPTION 'website_widgets: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.website_widgets ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.widget_call_sessions WHERE company_id IS NULL) THEN RAISE EXCEPTION 'widget_call_sessions: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.widget_call_sessions ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.api_keys WHERE company_id IS NULL) THEN RAISE EXCEPTION 'api_keys: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.api_keys ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.api_audit_logs WHERE company_id IS NULL) THEN RAISE EXCEPTION 'api_audit_logs: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.api_audit_logs ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.api_rate_limits WHERE company_id IS NULL) THEN RAISE EXCEPTION 'api_rate_limits: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.api_rate_limits ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.sip_trunks WHERE company_id IS NULL) THEN RAISE EXCEPTION 'sip_trunks: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.sip_trunks ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.sip_phone_numbers WHERE company_id IS NULL) THEN RAISE EXCEPTION 'sip_phone_numbers: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.sip_phone_numbers ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.sip_calls WHERE company_id IS NULL) THEN RAISE EXCEPTION 'sip_calls: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.sip_calls ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.user_addresses WHERE company_id IS NULL) THEN RAISE EXCEPTION 'user_addresses: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.user_addresses ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.user_feedback WHERE company_id IS NULL) THEN RAISE EXCEPTION 'user_feedback: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.user_feedback ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.google_calendar_credentials WHERE company_id IS NULL) THEN RAISE EXCEPTION 'google_calendar_credentials: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.google_calendar_credentials ALTER COLUMN company_id SET NOT NULL;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.google_sheets_credentials WHERE company_id IS NULL) THEN RAISE EXCEPTION 'google_sheets_credentials: company_id still has NULL rows'; END IF; END $$;
ALTER TABLE public.google_sheets_credentials ALTER COLUMN company_id SET NOT NULL;

-- ============================================================================
-- END OF DRAFT
-- ============================================================================
