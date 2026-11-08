-- DRAFT - DO NOT RUN until reviewed by Jason.
-- Backfill knowledge_base.company_id from the owning user's company.
-- Rows whose owner has no company are left NULL and listed by the report query below.
-- Run in one transaction. Review the report counts before COMMIT.

BEGIN;

-- 1. Report before change: how many rows are affected.
SELECT
  COUNT(*) FILTER (WHERE kb.company_id IS NULL AND u.company_id IS NOT NULL) AS will_backfill,
  COUNT(*) FILTER (WHERE kb.company_id IS NULL AND u.company_id IS NULL)     AS orphan_owner_no_company,
  COUNT(*) FILTER (WHERE kb.company_id IS NOT NULL)                          AS already_set
FROM knowledge_base kb
LEFT JOIN users u ON u.id = kb.user_id;

-- 2. Backfill. Only fills NULLs; never overwrites an existing company_id.
UPDATE knowledge_base kb
SET company_id = u.company_id
FROM users u
WHERE u.id = kb.user_id
  AND kb.company_id IS NULL
  AND u.company_id IS NOT NULL;

-- 3. Rows still NULL after backfill: owner has no company. Review before any delete.
SELECT kb.id, kb.user_id, kb.name
FROM knowledge_base kb
LEFT JOIN users u ON u.id = kb.user_id
WHERE kb.company_id IS NULL;

-- Check the counts above, then run COMMIT; or ROLLBACK; to abandon.
-- COMMIT;
ROLLBACK;
