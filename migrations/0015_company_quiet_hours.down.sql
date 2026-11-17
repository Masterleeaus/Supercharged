-- ============================================================
-- DOWN for migrations/0015_company_quiet_hours.sql (issue #251).
-- DATA LOSS: removes every company's quiet-hours settings. Disposable database or verified backup only.
-- ============================================================
DROP TABLE IF EXISTS company_quiet_hours;
