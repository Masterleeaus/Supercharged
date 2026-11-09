-- Product-specific Central SSO link lookup. No automatic provisioning.
-- This migration must be applied ONLY after the existing tenant schema
-- and restricted desk_app role are verified against the deployment.
BEGIN;
CREATE TABLE IF NOT EXISTS desk_central_identity_links (
 issuer text NOT NULL CHECK(length(issuer) BETWEEN 8 AND 256),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 256),
 company_id uuid NOT NULL,
 user_id varchar(255) NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'verified' CHECK(status IN ('verified','revoked')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 PRIMARY KEY(issuer,subject,company_id)
);
CREATE INDEX IF NOT EXISTS desk_central_identity_company_user_idx
 ON desk_central_identity_links(company_id,user_id,status);
ALTER TABLE desk_central_identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_central_identity_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON desk_central_identity_links FROM PUBLIC;
CREATE POLICY desk_central_identity_app_scope ON desk_central_identity_links
 FOR SELECT TO desk_app USING (
 company_id=nullif(current_setting('app.company_id',true),'')::uuid
);
CREATE OR REPLACE FUNCTION app_central_desk_resolve_link(
 p_issuer text,p_subject text,p_company_id uuid
)
RETURNS TABLE(user_id text,company_id uuid,role text,revision bigint,is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT u.id::text,l.company_id,u.role::text,l.revision,u.is_active
 FROM desk_central_identity_links l
 JOIN users u ON u.id::text=l.user_id AND u.company_id=l.company_id
 WHERE l.issuer=p_issuer AND l.subject=p_subject AND l.company_id=p_company_id
 AND l.status='verified' AND u.is_active IS TRUE
 AND u.is_deleted IS FALSE AND u.deleted_at IS NULL
 AND l.company_id=nullif(current_setting('app.company_id',true),'')::uuid
 LIMIT 2
$$;
REVOKE ALL ON FUNCTION app_central_desk_resolve_link(text,text,uuid) FROM PUBLIC;
-- Operator: review actual users schema and grant EXECUTE to desk_app only.
COMMIT;
