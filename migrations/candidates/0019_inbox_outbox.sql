-- REVIEW-ONLY candidate, never applied by the production migration runner.
-- Depends on 0010a_inbox.sql and restricted desk_app role from candidate 0018.
CREATE TABLE IF NOT EXISTS public.inbox_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 message_id varchar NOT NULL,
 channel varchar(16) NOT NULL CHECK (channel IN ('email','sms','whatsapp','web_chat','phone')),
 status varchar(16) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','retry','sent','dead')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 leased_until timestamptz,
 lease_token uuid,
 provider_id varchar(200),
 last_error varchar(512),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT inbox_outbox_company_message_uniq UNIQUE(company_id,message_id),
 CONSTRAINT inbox_outbox_company_id_uniq UNIQUE(company_id,id),
 CONSTRAINT inbox_outbox_message_fk FOREIGN KEY(company_id,message_id)
   REFERENCES public.inbox_messages(company_id,id),
 CONSTRAINT inbox_outbox_lease_pair CHECK ((status='leased') = (lease_token IS NOT NULL AND leased_until IS NOT NULL))
);
-- One provider acknowledgment ID must not ambiguously identify multiple messages within a company.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_outbox_company_provider_uidx ON public.inbox_outbox(company_id,provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_outbox_due_idx ON public.inbox_outbox(company_id,next_attempt_at,created_at)
 WHERE status IN ('queued','retry','leased');
ALTER TABLE public.inbox_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_outbox_tenant_boundary ON public.inbox_outbox;
CREATE POLICY inbox_outbox_tenant_boundary ON public.inbox_outbox FOR ALL TO desk_app
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_outbox TO desk_app;
