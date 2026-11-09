-- REVIEW-ONLY: not in the automatic production migration inventory.
-- Provider delivery callbacks are immutable, deduplicated evidence, NOT Inbox message status.
-- Requires 0010a inbox, 0018 Inbox RLS, 0019 Inbox outbox and restricted desk_app.
CREATE TABLE IF NOT EXISTS public.inbox_delivery_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 outbox_id uuid NOT NULL,
 provider varchar(32) NOT NULL,
 event_id varchar(200) NOT NULL,
 provider_id varchar(200) NOT NULL,
 outcome varchar(16) NOT NULL CHECK (outcome IN ('delivered','failed')),
 payload_sha256 varchar(64) NOT NULL,
 provider_event_at timestamptz,
 received_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT inbox_receipts_event_unique UNIQUE (company_id,provider,event_id),
 CONSTRAINT inbox_receipts_outbox_company_fk FOREIGN KEY (company_id,outbox_id)
   REFERENCES public.inbox_outbox(company_id,id),
 CONSTRAINT inbox_receipts_outcome_nonempty CHECK (length(provider)>0 AND length(event_id)>0 AND length(provider_id)>0)
);
CREATE INDEX IF NOT EXISTS inbox_receipts_outbox_idx ON public.inbox_delivery_receipts(company_id,outbox_id,received_at);
ALTER TABLE public.inbox_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_delivery_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_delivery_receipts_tenant_boundary ON public.inbox_delivery_receipts;
CREATE POLICY inbox_delivery_receipts_tenant_boundary ON public.inbox_delivery_receipts FOR ALL TO desk_app
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT, INSERT ON public.inbox_delivery_receipts TO desk_app;
