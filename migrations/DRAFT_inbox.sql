-- SUPERSEDED 2026-11-09: promoted to migrations/0010a_inbox.sql. Do not run; kept for history.
-- DRAFT - DO NOT RUN. Not part of the numbered migration sequence.
-- Matches server/modules/inbox/types.ts. Review before promoting to a numbered migration.
-- Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- Tenant key is company_id; there is no companies table yet, so no foreign key to one.
-- Child rows use composite foreign keys on (company_id, id), so a message cannot point at
-- another company's thread even if application code has a bug.
-- Row-level security is not included. Add it with migrations/DRAFT_company_scope.sql.

CREATE TABLE IF NOT EXISTS inbox_participants (
  id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid    NOT NULL,
  kind         varchar(16) NOT NULL CHECK (kind IN ('contact', 'staff', 'agent')),
  channel      varchar(16) CHECK (channel IN ('email', 'sms', 'whatsapp', 'web_chat', 'phone')),
  address      varchar(320),
  display_name varchar(200),
  created_at   timestamp NOT NULL DEFAULT now(),
  CONSTRAINT inbox_participants_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT inbox_participants_contact_address CHECK (kind <> 'contact' OR (channel IS NOT NULL AND address IS NOT NULL))
);

-- One contact per address per channel within a company.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_participants_contact_uidx
  ON inbox_participants (company_id, channel, address) WHERE kind = 'contact';

CREATE TABLE IF NOT EXISTS inbox_threads (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid    NOT NULL,
  channel         varchar(16) NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'web_chat', 'phone')),
  subject         varchar(300),
  status          varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'snoozed', 'closed')),
  assignee_kind   varchar(8) CHECK (assignee_kind IN ('human', 'agent')),
  assignee_id     varchar,
  last_message_at timestamp,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT inbox_threads_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT inbox_threads_assignee_pair CHECK ((assignee_kind IS NULL) = (assignee_id IS NULL))
);

CREATE INDEX IF NOT EXISTS inbox_threads_company_status_idx
  ON inbox_threads (company_id, status, updated_at);
CREATE INDEX IF NOT EXISTS inbox_threads_company_assignee_idx
  ON inbox_threads (company_id, assignee_id);

CREATE TABLE IF NOT EXISTS inbox_thread_participants (
  company_id     uuid    NOT NULL,
  thread_id      varchar NOT NULL,
  participant_id varchar NOT NULL,
  PRIMARY KEY (company_id, thread_id, participant_id),
  CONSTRAINT inbox_thread_participants_thread_fk
    FOREIGN KEY (company_id, thread_id) REFERENCES inbox_threads (company_id, id),
  CONSTRAINT inbox_thread_participants_participant_fk
    FOREIGN KEY (company_id, participant_id) REFERENCES inbox_participants (company_id, id)
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid    NOT NULL,
  thread_id    varchar NOT NULL,
  direction    varchar(8) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel      varchar(16) NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'web_chat', 'phone')),
  status       varchar(20) NOT NULL CHECK (status IN ('received', 'draft', 'awaiting_approval', 'queued', 'rejected')),
  author_kind  varchar(8) NOT NULL CHECK (author_kind IN ('contact', 'staff', 'agent')),
  author_id    varchar,
  body         text NOT NULL,
  body_sha256  varchar(64) NOT NULL,
  external_id  varchar(200),
  approval_id  varchar,
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now(),
  queued_at    timestamp,
  CONSTRAINT inbox_messages_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT inbox_messages_thread_fk
    FOREIGN KEY (company_id, thread_id) REFERENCES inbox_threads (company_id, id),
  -- Inbound messages are deduplicated per provider id. Outbound rows carry no external id.
  CONSTRAINT inbox_messages_inbound_external CHECK (direction = 'outbound' OR external_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_messages_external_uidx
  ON inbox_messages (company_id, channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_messages_company_thread_idx
  ON inbox_messages (company_id, thread_id, created_at);
