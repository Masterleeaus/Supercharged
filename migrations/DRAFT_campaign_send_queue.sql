-- DRAFT - DO NOT RUN. Not part of the numbered migration sequence.
-- Guard: the first statement raises, so running this file by accident fails immediately.
-- Promoting it means deleting the guard block and reviewing the rest.
DO $$ BEGIN RAISE EXCEPTION 'DRAFT_campaign_send_queue.sql is a draft and must not be run'; END $$;

-- Durable columns for the send queue (server/modules/campaigns/send-queue.ts).
-- Each campaign_send_jobs row is one queue entry: one recipient, one step, one campaign.
-- Depends on DRAFT_campaigns.sql being promoted first.
-- Not a replacement for the existing status compare-and-set. A claim is an extra guard on top of it.

ALTER TABLE campaign_send_jobs ADD COLUMN IF NOT EXISTS idempotency_key varchar(64);
ALTER TABLE campaign_send_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0
  CHECK (attempts >= 0);
ALTER TABLE campaign_send_jobs ADD COLUMN IF NOT EXISTS claim_token varchar(64);
ALTER TABLE campaign_send_jobs ADD COLUMN IF NOT EXISTS claimed_at timestamp;
ALTER TABLE campaign_send_jobs ADD COLUMN IF NOT EXISTS next_attempt_at timestamp NOT NULL DEFAULT now();
ALTER TABLE campaign_send_jobs ADD COLUMN IF NOT EXISTS last_error_code varchar(40);
ALTER TABLE campaign_send_jobs ADD COLUMN IF NOT EXISTS dead_lettered_at timestamp;

-- Idempotency: one job per recipient per step per campaign. sha256 over company, campaign, step, channel, address.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_send_jobs_company_idempotency_uidx
  ON campaign_send_jobs (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Claim: UPDATE campaign_send_jobs
--   SET claim_token = :token, claimed_at = now()
--   WHERE company_id = :company AND id = :job AND status = 'queued'
--     AND claim_token IS NULL AND next_attempt_at <= now() AND dead_lettered_at IS NULL;
-- Zero rows updated means another worker holds the job.
-- Attempt: UPDATE ... SET attempts = attempts + 1 WHERE ... AND claim_token = :token (before the transport call).
-- Release: UPDATE ... SET claim_token = NULL, claimed_at = NULL WHERE ... AND claim_token = :token.

-- Recovery scan: claims older than the timeout. Dead-lettered rows are excluded.
CREATE INDEX IF NOT EXISTS campaign_send_jobs_claim_recovery_idx
  ON campaign_send_jobs (company_id, status, claimed_at)
  WHERE claim_token IS NOT NULL AND dead_lettered_at IS NULL;

-- Due-work scan: queued jobs ready to try.
CREATE INDEX IF NOT EXISTS campaign_send_jobs_due_idx
  ON campaign_send_jobs (company_id, status, next_attempt_at)
  WHERE status = 'queued';
