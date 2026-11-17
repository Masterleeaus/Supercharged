-- ============================================================
-- DOWN for migrations/0018_central_sso_company_links.sql (issue #251).
-- 0018 is marked forward-only in its header; this down is an explicit, reviewed reversal for
-- disposable databases and for the rollback/re-apply test. Drops the lookup function, then the
-- link table (its index and RLS policy go with it).
-- ============================================================
BEGIN;
DROP FUNCTION IF EXISTS app_central_desk_resolve_link(text, text, uuid);
DROP TABLE IF EXISTS desk_central_identity_links;
COMMIT;
