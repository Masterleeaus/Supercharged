-- DRAFT: NOT APPLIED. Review before running. Additive only.
-- Adds a nullable delivery_status column to webhook_logs (outbound webhook delivery log).
-- Values written by application code: delivered, retrying, dead_letter, superseded. No enum or default.
-- 'superseded' marks an earlier 'retrying' attempt once the delivery has ended (delivered or dead_letter).

ALTER TABLE public.webhook_logs ADD COLUMN IF NOT EXISTS delivery_status text;
CREATE INDEX IF NOT EXISTS webhook_logs_delivery_status_idx ON public.webhook_logs (delivery_status);
