-- ============================================================
-- Add missing columns to ve_sessions and leads tables
-- Run this against the production DB to fix CRM lead processor errors
-- ============================================================

BEGIN;

-- 1. Add classification column to ve_sessions (for CRM lead processor)
ALTER TABLE ve_sessions
  ADD COLUMN IF NOT EXISTS classification VARCHAR(50);

-- 2. Add sip_call_id column to leads (SIP engine lead linking)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS sip_call_id VARCHAR REFERENCES sip_calls(id) ON DELETE SET NULL;

-- 3. Add ve_session_id column to leads (Custom Voice Engine lead linking)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS ve_session_id VARCHAR;

COMMIT;

