# Owner company_id backfill

Release runbook for setting `users.company_id` on owner accounts that were created before company scoping was enforced.

## Verified behaviour (code checked for this doc)

- `users.company_id` is nullable. In `shared/schema.ts` the column is `companyId: uuid("company_id")` with no `.notNull()`, and it is indexed as `users_company_id_idx`. Owner rows can therefore be NULL.
- The company id is a UUID that should match `companies.id` (`companies` table, `id uuid primary key`). `isCompanyId()` in `server/infrastructure/database/tenant-context.ts` only checks the UUID format. It does not check that the company row exists.
- Team members take their company from their parent row. `lookupParentCompanyId()` in `server/middleware/team-member-company.ts` reads `users.company_id` for the parent user (via `team_members.team_id -> teams.user_id -> users.id`). If the parent value is NULL or not a UUID, it returns `undefined`. A NULL owner therefore also leaves every team member without a company.
- Tokens carry a company claim only when the value is a valid UUID. `companyClaim()` in `server/middleware/auth.ts` writes it at issue time, and `companyIdFromClaims()` reads it back from a verified token. Tokens issued before the owner was backfilled have no claim, so `req.user.companyId` stays `undefined`.
- `requireCompanyScope()` in `server/middleware/company-scope.ts` returns `403 Company scope required` when there is no company id. Requests fail closed until the user holds a token with a valid claim.

## 1. Find owners with NULL company_id

Read-only. Review the output before any update.

```sql
-- NOT RUN. Suggested query: list owner accounts with no company id.
SELECT id, email, name, created_at
FROM users
WHERE company_id IS NULL
ORDER BY created_at;
```

Then count the team members who depend on those owners:

```sql
-- NOT RUN. Suggested query: count team members whose parent owner has no company id.
-- Adjust the join if the teams schema differs from the one in team-member-company.ts.
SELECT u.id AS owner_id, COUNT(tm.id) AS team_members
FROM users u
JOIN teams t ON t.user_id = u.id
JOIN team_members tm ON tm.team_id = t.id
WHERE u.company_id IS NULL
GROUP BY u.id;
```

## 2. Set company_id

The owner UUID must be a valid company id: a UUID that exists in `companies.id`. Confirm the company row first.

```sql
-- NOT RUN. Suggested query: confirm the target company exists.
-- Replace the placeholder with the real company UUID.
SELECT id, name FROM companies WHERE id = '00000000-0000-0000-0000-000000000000';
```

```sql
-- NOT RUN. Suggested update: set company_id on one owner.
-- Replace both placeholders. Run inside a transaction and check the row count (expect 1).
BEGIN;
UPDATE users
SET company_id = '00000000-0000-0000-0000-000000000000',
    updated_at = now()
WHERE id = 'OWNER_USER_ID'
  AND company_id IS NULL;
-- Expect UPDATE 1. If the count is not 1, run ROLLBACK and investigate.
COMMIT;
```

Only set `company_id` on owner rows you have confirmed. Do not bulk-update every NULL row without reviewing the list from step 1.

## 3. Re-login step

Setting the column does not change tokens that were already issued. For each backfilled owner:

1. Sign out of every active session for that owner.
2. Sign in again so a new token is issued with the company claim.
3. Confirm that a company-scoped request succeeds. A `403 Company scope required` response means the new token still has no valid claim. Check the `users.company_id` value first.

Team members pick up the company from the parent owner on their next request, so they do not need their own update. If a team member still gets `403`, check that the owner's column is set and that the team member's token was issued after the backfill.

## 4. Rollback

To undo a backfill, set the column back to NULL for the affected owner rows:

```sql
-- NOT RUN. Suggested rollback: clear company_id on rows updated in step 2.
-- Replace the placeholder with the owner id that was changed.
BEGIN;
UPDATE users
SET company_id = NULL,
    updated_at = now()
WHERE id = 'OWNER_USER_ID'
  AND company_id = '00000000-0000-0000-0000-000000000000';
-- Expect UPDATE 1.
COMMIT;
```

Notes on rollback:

- Clearing the column stops new tokens from carrying a company claim, and team members lose their company again.
- Tokens already issued still carry the claim until they expire. Access tokens are short-lived (15 minutes for the short token in `generateShortAccessToken`), but check the expiry of any longer-lived token type before you rely on rollback to cut access quickly.
- The fail-closed behaviour is the safe default. Rolling back returns the owner and team to a 403 state, not to unscoped access.

## Placeholders

- `00000000-0000-0000-0000-000000000000`: replace with a real `companies.id` value.
- `OWNER_USER_ID`: replace with the `users.id` of the owner being changed.
