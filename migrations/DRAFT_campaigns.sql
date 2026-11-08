-- DRAFT - DO NOT RUN. Not part of the numbered migration sequence.
-- OPEN DECISION: table-name conflict. The name campaigns is already used by the live legacy
-- voice-call table (shared/schema.ts, keyed by user_id). This file's CREATE TABLE IF NOT EXISTS campaigns
-- would silently no-op on a database that has the legacy table. Owner must choose a new name or a merge plan.
-- DO NOT PROMOTE this file until that decision is resolved.
-- Matches server/modules/campaigns/types.ts. Review before promoting to a numbered migration.
-- Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- Tenant key is company_id; there is no companies table yet, so no foreign key to one.
-- Note: the existing shared/schema.ts campaigns table is voice-call oriented and keyed by user_id.
-- This draft is a separate, channel-neutral model. Do not merge the two without a plan.

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid    NOT NULL,
  channel      varchar(8) NOT NULL CHECK (channel IN ('email', 'sms')),
  address      varchar(320) NOT NULL,
  display_name varchar(200),
  tags         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamp NOT NULL DEFAULT now(),
  CONSTRAINT campaign_contacts_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT campaign_contacts_company_address_uidx UNIQUE (company_id, channel, address)
);

CREATE TABLE IF NOT EXISTS campaign_audiences (
  id          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid    NOT NULL,
  name        varchar(120) NOT NULL,
  channel     varchar(8) NOT NULL CHECK (channel IN ('email', 'sms')),
  tags_all    jsonb NOT NULL CHECK (jsonb_typeof(tags_all) = 'array' AND jsonb_array_length(tags_all) > 0),
  created_at  timestamp NOT NULL DEFAULT now(),
  CONSTRAINT campaign_audiences_company_id_uidx UNIQUE (company_id, id)
);

-- Consent. Active while revoked_at is null. Address is normalised before insert.
CREATE TABLE IF NOT EXISTS campaign_opt_ins (
  id          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid    NOT NULL,
  channel     varchar(8) NOT NULL CHECK (channel IN ('email', 'sms')),
  address     varchar(320) NOT NULL,
  source      varchar(200) NOT NULL,
  granted_at  timestamp NOT NULL DEFAULT now(),
  revoked_at  timestamp,
  CONSTRAINT campaign_opt_ins_company_id_uidx UNIQUE (company_id, id)
);

CREATE INDEX IF NOT EXISTS campaign_opt_ins_company_address_idx
  ON campaign_opt_ins (company_id, channel, address);

CREATE TABLE IF NOT EXISTS campaign_unsubscribes (
  company_id  uuid    NOT NULL,
  channel     varchar(8) NOT NULL CHECK (channel IN ('email', 'sms')),
  address     varchar(320) NOT NULL,
  reason      varchar(200),
  created_at  timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, channel, address)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid    NOT NULL,
  name         varchar(120) NOT NULL,
  channel      varchar(8) NOT NULL CHECK (channel IN ('email', 'sms')),
  audience_id  varchar NOT NULL,
  status       varchar(16) NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT campaigns_audience_fk FOREIGN KEY (company_id, audience_id) REFERENCES campaign_audiences (company_id, id)
);

CREATE TABLE IF NOT EXISTS campaign_steps (
  id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid    NOT NULL,
  campaign_id  varchar NOT NULL,
  position     integer NOT NULL CHECK (position >= 1),
  delay_hours  integer NOT NULL DEFAULT 0 CHECK (delay_hours BETWEEN 0 AND 8760),
  subject      varchar(300),
  body         text NOT NULL,
  created_at   timestamp NOT NULL DEFAULT now(),
  CONSTRAINT campaign_steps_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT campaign_steps_company_campaign_id_uidx UNIQUE (company_id, id, campaign_id),
  CONSTRAINT campaign_steps_position_uidx UNIQUE (company_id, campaign_id, position),
  CONSTRAINT campaign_steps_campaign_fk FOREIGN KEY (company_id, campaign_id) REFERENCES campaigns (company_id, id)
);

-- One row per recipient per step. approval_id binds the row to the batch approval.
-- status changes are compare-and-set: UPDATE ... WHERE company_id = ? AND id = ? AND status = ?.
CREATE TABLE IF NOT EXISTS campaign_send_jobs (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid    NOT NULL,
  campaign_id     varchar NOT NULL,
  step_id         varchar NOT NULL,
  contact_id      varchar NOT NULL,
  channel         varchar(8) NOT NULL CHECK (channel IN ('email', 'sms')),
  address         varchar(320) NOT NULL,
  status          varchar(20) NOT NULL DEFAULT 'awaiting_approval'
                  CHECK (status IN ('awaiting_approval', 'queued', 'sending', 'sent', 'skipped', 'failed')),
  skip_reason     varchar(24) CHECK (skip_reason IN (
                    'unsubscribed', 'no_opt_in', 'approval_rejected', 'approval_expired',
                    'no_consent', 'channel_not_consented', 'opted_out', 'quiet_hours',
                    'invalid_contact', 'suppressed')),
  in_approved_set boolean NOT NULL DEFAULT false,
  approval_id     varchar,
  external_id     varchar(200),
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT campaign_send_jobs_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT campaign_send_jobs_recipient_uidx UNIQUE (company_id, step_id, contact_id),
  CONSTRAINT campaign_send_jobs_step_fk FOREIGN KEY (company_id, step_id) REFERENCES campaign_steps (company_id, id),
  CONSTRAINT campaign_send_jobs_step_campaign_fk FOREIGN KEY (company_id, step_id, campaign_id) REFERENCES campaign_steps (company_id, id, campaign_id),
  CONSTRAINT campaign_send_jobs_contact_fk FOREIGN KEY (company_id, contact_id) REFERENCES campaign_contacts (company_id, id),
  CONSTRAINT campaign_send_jobs_skip_reason_chk CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS campaign_send_jobs_company_approval_idx
  ON campaign_send_jobs (company_id, approval_id);
CREATE INDEX IF NOT EXISTS campaign_send_jobs_company_step_idx
  ON campaign_send_jobs (company_id, campaign_id, step_id, status);
