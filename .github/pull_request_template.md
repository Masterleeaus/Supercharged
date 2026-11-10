## Summary

<!-- What changes, and why. One or two sentences is enough. -->

## Linked issue

<!-- "Closes #NNN" or "Refs #NNN". Every change should link to an issue or a ROADMAP phase. -->

## Tests run

<!-- List the exact commands you ran and the result of each, for example:
- node scripts/typecheck-area.mjs shared -> fails (existing errors, see #122)
- node --test tests/scripts/migration-inventory.test.mjs -> 4 pass
Say "not run" with a reason for anything you skipped. -->

## Migration impact

<!-- "None" if no database change. Otherwise: migration file names, whether they are additive and reversible, and whether scripts/run-safe-migration.mjs lists them. -->

## Tenant impact

<!-- Which company or tenant data this touches, and how tenant scope is enforced (route guard, query filter, or RLS). "None" only if no tenant data is read or written. -->

## Rollback

<!-- How to undo this change: revert the commit, a feature flag, or a manual step. Name any data that cannot be rolled back. -->
