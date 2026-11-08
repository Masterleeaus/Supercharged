# Trust readiness (clean-room port)

This directory is a **clean-room TypeScript port**. No source was copied from the
source repository. The code was written from observed behaviour and the rules it
enforces. Identifiers, comments, test fixtures and data files were not carried over.

- **Source repo:** `Masterleeaus/Trust-Engine` (PHP/Laravel extension). The source
  has no LICENSE or NOTICE, and its PROVENANCE.md leaves reuse as an owner decision.
  Nothing from it is vendored here.
- **Ported behaviours:**
  - Evidence rule selection: a specificity score that picks the best applicable rule
    (template match, then job type and site type, then job type only, then site type
    only, then a catch-all rule).
  - Requirement merging over default counts for `before`, `after`, `incident`,
    `signoff` and `general`.
  - Captured, missing and ready calculation for one job.
- **Not ported:** GPS trust levels, attendance derivation, field-job, sign-off and
  incident domain logic. Those belong to Titan Zero Field.

## Deliberate differences from the source

- **Fail closed.** With no applicable rule, the result is `status: "no_rule"` and
  `ready: false`. The source reports ready in that case.
- **Non-matching rules are never selected.** The source's selection can pick a rule
  that matches nothing when no rule scores above its starting value. Here, only
  rules with a positive score are eligible.
- **Company scoping.** Every call requires `companyId`. Rules and items from another
  company are ignored. The caller loads the rows, so the evaluator is still pure.
- **Strict input.** Non-integer or negative required counts throw
  `TrustReadinessError`. They are not silently coerced.
- **No user id.** The source accepts an unused user id. It is not part of this API.

## Files

- `evaluator.ts` - pure evaluator.
- `index.ts` - re-exports.
- Tests: `tests/engines/trust-readiness.test.mjs` (`node --test`).
