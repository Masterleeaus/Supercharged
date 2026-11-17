-- ============================================================
-- DOWN for migrations/0019_central_sso_pending_logins.sql (issue #251).
-- DATA LOSS: removes in-flight pending SSO logins. Disposable database or verified backup only.
-- ============================================================
DROP TABLE IF EXISTS central_sso_pending_logins;
