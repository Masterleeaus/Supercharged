-- ============================================================
-- DOWN for migrations/0016_chatbot_reminder_pipeline.sql (issue #251).
-- Drops the five chatbot pipeline tables in reverse creation order (children first).
-- DATA LOSS: removes outbox, webhook and reminder ledger rows. Disposable database or verified backup only.
-- ============================================================
DROP TABLE IF EXISTS chatbot_booking_reminder_attempts;
DROP TABLE IF EXISTS chatbot_booking_reminder_sends;
DROP TABLE IF EXISTS chatbot_webhook_deliveries;
DROP TABLE IF EXISTS chatbot_webhook_subscriptions;
DROP TABLE IF EXISTS chatbot_event_outbox;
