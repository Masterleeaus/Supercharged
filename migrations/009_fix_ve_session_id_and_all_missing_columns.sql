-- ============================================================
-- Migration 009: columns that the voice-engine code uses and that no runner migration creates.
--
-- Source: shared/schema.ts (leads.ve_session_id, leads.sip_call_id) and the ALTER TABLE
-- statements in scripts/apply-plugin-sql-direct.ts (ve_voice_agents 002-004), plus the
-- ve_sessions analysis columns used by server/engines/crm/lead-processor.service.ts.
--
-- Adds columns only. No DROP, no ALTER TYPE, no column is changed or removed.
-- Runs after 008, so the ve_* tables exist. Idempotent (ADD COLUMN IF NOT EXISTS).
--
-- Not covered here: other schema.ts columns that no runner migration creates (for example
-- company_id on about 50 tables). That is a separate owner decision. See the checklist.
-- ============================================================

-- leads: Custom Voice Engine and SIP engine lead linking
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS ve_session_id VARCHAR;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS sip_call_id VARCHAR REFERENCES sip_calls(id) ON DELETE SET NULL;

-- ve_sessions: AI analysis columns written by the CRM lead processor
ALTER TABLE ve_sessions
  ADD COLUMN IF NOT EXISTS classification TEXT,
  ADD COLUMN IF NOT EXISTS sentiment TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary TEXT;

-- ve_voice_agents: voice-agent settings added after the base table (DDL steps 002-004)
ALTER TABLE ve_voice_agents
  ADD COLUMN IF NOT EXISTS detect_language_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE ve_voice_agents
  ADD COLUMN IF NOT EXISTS appointment_booking_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS end_conversation_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS transfer_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS transfer_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS messaging_email_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS messaging_whatsapp_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS messaging_email_template TEXT,
  ADD COLUMN IF NOT EXISTS messaging_whatsapp_template TEXT;

ALTER TABLE ve_voice_agents
  ADD COLUMN IF NOT EXISTS stt_model TEXT,
  ADD COLUMN IF NOT EXISTS tts_model TEXT;
