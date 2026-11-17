-- ============================================================
-- DOWN for migrations/0017_user_company_memberships.sql (issue #251).
-- Matches the ROLLBACK note in 0017. Removes memberships only; users.company_id is untouched.
-- DATA LOSS: removes every membership row. Disposable database or verified backup only.
-- ============================================================
DROP TABLE IF EXISTS user_company_memberships;
