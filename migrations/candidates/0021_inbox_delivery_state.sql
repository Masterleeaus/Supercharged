-- REVIEW-ONLY candidate. Must follow 0019 outbox and 0020 delivery receipts.
-- Durable delivery projection is distinct from a queued/sent Inbox message.
CREATE TABLE IF NOT EXISTS public.inbox_delivery_state (
 company_id uuid NOT NULL,
 outbox_id uuid NOT NULL,
 outcome varchar(16) NOT NULL CHECK (outcome IN ('delivered','failed')),
 event_id varchar(200) NOT NULL,
 provider_event_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,outbox_id),
 CONSTRAINT inbox_delivery_state_outbox_fk FOREIGN KEY(company_id,outbox_id)
   REFERENCES public.inbox_outbox(company_id,id)
);
ALTER TABLE public.inbox_delivery_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_delivery_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_delivery_state_tenant_boundary ON public.inbox_delivery_state;
CREATE POLICY inbox_delivery_state_tenant_boundary ON public.inbox_delivery_state FOR ALL TO desk_app
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE ON public.inbox_delivery_state TO desk_app;
