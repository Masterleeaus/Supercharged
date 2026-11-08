-- DRAFT - DO NOT RUN. Not part of the numbered migration sequence.
-- Matches server/modules/marketing/types.ts. Review before promoting to a numbered migration.
-- Idempotent (IF NOT EXISTS) so a later re-run is safe.
-- Tenant key is company_id; there is no companies table yet, so no foreign key to one.
-- campaign_id and chatbot_id are references only. The campaigns and chatbot tables own them,
-- and they are not declared as foreign keys here, so this draft does not depend on those drafts.

CREATE TABLE IF NOT EXISTS landing_pages (
  id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid    NOT NULL,
  slug         varchar(80) NOT NULL,
  title        varchar(200) NOT NULL,
  status       varchar(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sections     jsonb NOT NULL DEFAULT '[]'::jsonb,
  campaign_id  varchar,
  chatbot_id   varchar,
  author_kind  varchar(8) NOT NULL CHECK (author_kind IN ('human', 'agent')),
  author_id    varchar NOT NULL,
  published_at timestamp,
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now(),
  CONSTRAINT landing_pages_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT landing_pages_company_slug_uidx UNIQUE (company_id, slug),
  CONSTRAINT landing_pages_slug_chk CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE INDEX IF NOT EXISTS landing_pages_company_status_idx
  ON landing_pages (company_id, status);
CREATE INDEX IF NOT EXISTS landing_pages_company_campaign_idx
  ON landing_pages (company_id, campaign_id);

CREATE TABLE IF NOT EXISTS content_items (
  id           varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid    NOT NULL,
  kind         varchar(16) NOT NULL CHECK (kind IN ('blog_post', 'social_post', 'email_copy', 'ad_copy')),
  title        varchar(200) NOT NULL,
  body         text NOT NULL,
  status       varchar(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'archived')),
  campaign_id  varchar,
  author_kind  varchar(8) NOT NULL CHECK (author_kind IN ('human', 'agent')),
  author_id    varchar NOT NULL,
  published_at timestamp,
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now(),
  CONSTRAINT content_items_company_id_uidx UNIQUE (company_id, id)
);

CREATE INDEX IF NOT EXISTS content_items_company_status_idx
  ON content_items (company_id, status, kind);
CREATE INDEX IF NOT EXISTS content_items_company_campaign_idx
  ON content_items (company_id, campaign_id);
