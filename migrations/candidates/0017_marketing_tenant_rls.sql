-- REVIEW CANDIDATE ONLY. NOT in the automatic migration manifest.
-- Prerequisite: an existing restricted desk_app role (NO BYPASSRLS, not table owner).
-- This candidate promotes the archived Marketing schema and adds forced tenant RLS.
-- The application login must already be authorised to SET LOCAL ROLE desk_app.
DO $guard$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='desk_app'
     AND NOT rolsuper AND NOT rolbypassrls) THEN
  RAISE EXCEPTION 'Marketing migration requires a non-superuser desk_app role without BYPASSRLS';
 END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS landing_pages (
 id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
 company_id uuid NOT NULL,
 slug varchar(80) NOT NULL,
 title varchar(200) NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
 sections jsonb NOT NULL DEFAULT '[]'::jsonb,
 campaign_id varchar,
 chatbot_id varchar,
 author_kind varchar(8) NOT NULL CHECK (author_kind IN ('human','agent')),
 author_id varchar NOT NULL,
 published_at timestamp,
 created_at timestamp NOT NULL DEFAULT now(),
 updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT landing_pages_company_id_uidx UNIQUE(company_id,id),
 CONSTRAINT landing_pages_company_slug_uidx UNIQUE(company_id,slug),
 CONSTRAINT landing_pages_slug_chk CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
CREATE INDEX IF NOT EXISTS landing_pages_company_status_idx ON landing_pages(company_id,status);
CREATE INDEX IF NOT EXISTS landing_pages_company_campaign_idx ON landing_pages(company_id,campaign_id);

CREATE TABLE IF NOT EXISTS content_items (
 id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
 company_id uuid NOT NULL,
 kind varchar(16) NOT NULL CHECK (kind IN ('blog_post','social_post','email_copy','ad_copy')),
 title varchar(200) NOT NULL,
 body text NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','published','archived')),
 campaign_id varchar,
 author_kind varchar(8) NOT NULL CHECK (author_kind IN ('human','agent')),
 author_id varchar NOT NULL,
 published_at timestamp,
 created_at timestamp NOT NULL DEFAULT now(),
 updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT content_items_company_id_uidx UNIQUE(company_id,id)
);
CREATE INDEX IF NOT EXISTS content_items_company_status_idx ON content_items(company_id,status,kind);
CREATE INDEX IF NOT EXISTS content_items_company_campaign_idx ON content_items(company_id,campaign_id);

ALTER TABLE landing_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landing_pages_tenant_boundary ON landing_pages;
CREATE POLICY landing_pages_tenant_boundary ON landing_pages
 FOR ALL TO desk_app
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);
DROP POLICY IF EXISTS content_items_tenant_boundary ON content_items;
CREATE POLICY content_items_tenant_boundary ON content_items
 FOR ALL TO desk_app
 USING (company_id = nullif(current_setting('app.company_id',true),'')::uuid)
 WITH CHECK (company_id = nullif(current_setting('app.company_id',true),'')::uuid);

GRANT USAGE ON SCHEMA public TO desk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON landing_pages TO desk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON content_items TO desk_app;
-- No GRANT to PUBLIC, no password, no database role ownership changes.
