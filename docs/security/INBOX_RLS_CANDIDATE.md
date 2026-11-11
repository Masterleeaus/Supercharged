# Inbox RLS candidate — Pass 15

Four existing Inbox tables from `migrations/0010a_inbox.sql` gain a reviewed **candidate** that enables and FORCEs row-level security and enforces `company_id` against transaction-local `app.company_id` for read and write operations. The candidate does not create database roles or passwords and is **not present in the production migration runner**.

A new dedicated disposable PostgreSQL CI job applies the original numbered Inbox DDL followed by the candidate. Tests cover real reads/writes, company isolation, restricted role behavior, composite foreign keys, deduplicated external IDs, transaction rollback and pinned inbound advisory locks. A passing CI job is not production deployment. Inbox remains off until the candidate is reviewed, permissions/role membership are deployed and approval-provider wiring is validated.
