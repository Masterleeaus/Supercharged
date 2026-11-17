-- ============================================================
-- DOWN for migrations/0023_marketing_tables_tenant_rls.sql (issue #251).
-- Removes the tenant policies and the two Marketing tables. Grants and RLS settings go with the tables.
-- DATA LOSS: removes landing pages and content items. Disposable database or verified backup only.
-- ============================================================
DROP POLICY IF EXISTS landing_pages_tenant_boundary ON landing_pages;
DROP POLICY IF EXISTS content_items_tenant_boundary ON content_items;
DROP TABLE IF EXISTS content_items;
DROP TABLE IF EXISTS landing_pages;
