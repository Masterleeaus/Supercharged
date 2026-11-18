-- CI-only stub for scripts/tenant-postgres-prepare.mjs.
-- Migration 0026 alters website_widgets, which is created by the base schema (0000), and that
-- base schema is not applied in this job. This stub gives 0026 the columns it reads (id, user_id).
-- Test-only. Never applied to a persistent database.
CREATE TABLE IF NOT EXISTS website_widgets (
  id varchar PRIMARY KEY,
  user_id varchar
);
