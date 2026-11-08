-- ============================================================
-- DRAFT - NOT APPLIED
-- This file is a draft for review only. It has NOT been run against any
-- database, is NOT listed in migrations/meta/_journal.json, and is NOT
-- picked up by any migration runner. Do not add it to the automatic
-- migration sequence without review.
-- Depends on public.companies from DRAFT_companies_foundation.sql, which
-- must be applied before this file.
-- Later step, not in this draft: a foreign key from action_ledger.company_id
-- to public.companies(id). Left out here to match the foundation draft.
-- ============================================================
-- Action ledger (Auto tier, second database). See docs/AUTO_RECONCILIATION_DESIGN.md
-- sections 2 and 3. Every action the AI takes gets a row here. The reconciliation
-- engine checks these rows against the live business data.
--   * Creates public.action_ledger only.
--   * company_id is NOT NULL: every ledger row belongs to a company.
--   * Append-only is enforced by privileges, not by convention (see REVOKE below).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.action_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  actor           text NOT NULL,
  agent_id        text NULL,
  tier            text NOT NULL,
  action          text NOT NULL,
  parameters_hash text NOT NULL,
  policy_version  text NULL,
  outcome         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_ledger_company_id_created_at_idx
  ON public.action_ledger (company_id, created_at);

-- Append-only at the database level. Revoking from PUBLIC removes the default
-- privileges that every role inherits. The application role must be granted
-- INSERT and SELECT on public.action_ledger, and nothing else. That role is
-- created out of band and is NOT created in this file. The table owner keeps
-- its own privileges, so the owner role must not be the application role.
REVOKE UPDATE, DELETE, TRUNCATE ON public.action_ledger FROM PUBLIC;
