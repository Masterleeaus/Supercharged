-- DRAFT - NOT APPLIED. Do not run. Not part of the numbered migration sequence and not in the journal.
-- Maps the five retired autonomy values on workforce_agents.autonomy to the current tiers.
-- Mapping (decided): observe_only -> assist; recommend_only -> suggest; prepare_only -> suggest;
-- approval_required -> auto; delegated_autonomous -> auto. Predictive is never assigned here.
-- Only rows holding an old value are touched, so a re-run matches zero rows (idempotent).
-- Rows already on a current value are left alone by the WHERE clause and the ELSE branch.
-- Run only against a database that still holds the old values. DRAFT_workforce_agents.sql allows only
-- the current values in its CHECK constraint, so that constraint must be relaxed first if it already exists.

UPDATE workforce_agents
SET
  autonomy = CASE autonomy
    WHEN 'observe_only' THEN 'assist'
    WHEN 'recommend_only' THEN 'suggest'
    WHEN 'prepare_only' THEN 'suggest'
    WHEN 'approval_required' THEN 'auto'
    WHEN 'delegated_autonomous' THEN 'auto'
    ELSE autonomy
  END,
  updated_at = now()
WHERE autonomy IN ('observe_only', 'recommend_only', 'prepare_only', 'approval_required', 'delegated_autonomous');
