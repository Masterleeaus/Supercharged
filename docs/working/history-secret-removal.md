# Plan: remove committed secret files and archives from git history

Date: 2026-11-15
Refs: issue #2 (webhook secret files committed to git), issue #133 (committed archives, logs, ignore rules)
Status: PLAN ONLY. Nothing has been rewritten, pushed, or deleted. Owner approval is needed before any step in "Execute".

Scope note: this plan was made from paths and commit SHAs only. No secret file was opened, and no secret value was printed. Content-level scanning (gitleaks or similar) has not been run yet. It is step 3 below.

## 1. What is in history

Repo: Masterleeaus/Supercharged. Default branch: main. Commits on all refs: 558. Open PRs: 17.

### Secret files (issue #2)

Both files are root-level, both are already untracked on main (removed in ba70cf9, 2026-11-08), and both are still in history.

- `.appointment-webhook-secret`: added in 27c969d (2026-11-08). Reachable from main.
- `.rag-webhook-secret`: added in 27c969d (2026-11-08). Reachable from main.

The .gitignore on main already lists both names (lines 11 and 12). The problem is history only.

### Archives and logs (issue #133)

- `Desk.zip`: added in 27c969d. Deleted again in 967c2e9.
- `Desk backup.zip`: added in 27c969d. Deleted again in 967c2e9.
- `Desk-Chatbot-Port-COMPLETE-2026-11-09-r3.zip`: added in 0d93ec0 (2026-11-09). Deleted again in 967c2e9.
- `desk.log`: added in 27c969d. Deleted again in 967c2e9.

Member names inside the zips were listed (not extracted). None of the zips contain a `.env` file or a file named like a secret file. The Chatbot zip holds code files whose names contain "secret" or "credential". Those are code, not secrets. The member contents were not checked, and `desk.log` was not opened.

### Name-only matches (keep unless the owner says otherwise)

These match a secret-like name pattern but are code or SQL, not secret files:

- `migrations/0002_add_google_sheets_credentials.sql` (added in 27c969d)
- `migrations/DRAFT_credential_encryption_backfill.sql` and `migrations/archive/DRAFT_credential_encryption_backfill.sql`
- Credential and secret code files under `server/` and `tests/` (for example `server/modules/chatbot/channels/credentials.ts`)

### Not checked by name only

- `server/routes/webhook-routes.ts.backup` (in 27c969d). It is a backup copy of code, and it could hold an inline value. Needs the content scan in step 3.
- `.gitleaks.toml` (in f37ae95). It is config. Keep.

## 2. Paths to remove (the approval list)

Required by issue #2:

1. `.appointment-webhook-secret`
2. `.rag-webhook-secret`

Recommended by issue #133 (owner to confirm each):

3. `Desk.zip`
4. `Desk backup.zip`
5. `Desk-Chatbot-Port-COMPLETE-2026-11-09-r3.zip`
6. `desk.log`

Total paths for approval: 6. Two are required, four are recommended.

## 3. Content scan before rewriting (owner or follow-up agent)

Path names do not prove that history is clean. Run gitleaks on a mirror clone and save the output in a private place. Use redacted output only.

```
gitleaks detect --source supercharged-rewrite.git --log-opts="--all" --redact --report-format json --report-path ~/private/gitleaks-history.json
```

Look at every finding. Each finding is a candidate for rotation or for removal. Check `server/routes/webhook-routes.ts.backup` and the contents of the four archives and the log.

## 4. Rewrite plan (git-filter-repo)

Run in a fresh mirror clone, never in a working copy.

```
git clone --mirror https://github.com/Masterleeaus/Supercharged.git supercharged-rewrite.git
cd supercharged-rewrite.git

# keep an untouched backup first (it still contains the secrets; keep it private)
cp -a . ../supercharged-backup-before-rewrite.git

git filter-repo --force \
  --invert-paths \
  --path .appointment-webhook-secret \
  --path .rag-webhook-secret \
  --path 'Desk.zip' \
  --path 'Desk backup.zip' \
  --path 'Desk-Chatbot-Port-COMPLETE-2026-11-09-r3.zip' \
  --path desk.log
```

Notes on the command:

- `--path` matches exact paths. All six are root-level files, so there is no risk of removing a same-named file in a subfolder.
- Drop the four item-3-to-6 `--path` lines if the owner does not approve them.
- `git filter-repo` removes the `origin` remote from the mirror on purpose. Add it back before pushing.

Verify (expect 0 for each line):

```
git log --all --name-only --format= | grep -xE '\.appointment-webhook-secret|\.rag-webhook-secret|Desk\.zip|Desk backup\.zip|Desk-Chatbot-Port-COMPLETE-2026-11-09-r3\.zip|desk\.log' | wc -l
git rev-list --all --count   # will be lower or the same as 558; compare with the backup
```

Also re-run the gitleaks command from step 3. It should show no findings for the removed paths.

## 5. Force-push (owner approval needed)

This changes the SHA of every commit from 27c969d onward. It cannot be undone except from the private backup.

Order:

1. Owner approves this plan and the path list.
2. Owner confirms every value in step 6 is rotated.
3. Announce a freeze: no pushes for about 30 minutes.
4. Owner temporarily disables force-push protection on main (repo settings, branch rules). Note the rule so it can be restored.
5. Push. Use the owner's account, not an agent:

```
git remote add origin https://github.com/Masterleeaus/Supercharged.git
git push --force origin 'refs/heads/*' 'refs/tags/*'
```

All branches must be pushed, not only main. Otherwise the secret blobs stay reachable on the other branches (there are many `claude/*` and other branches that contain the files). If the owner wants to keep some branches unchanged, those branches still need the secret removal or must be deleted. Decide which before the push.

6. Restore the force-push protection on main.
7. Ask GitHub Support to purge cached views and unreachable objects. Old commit SHAs remain reachable through `refs/pull/*` and cached PR pages until GitHub garbage-collects them. The owner cannot push or rewrite `refs/pull/*`, so this step has to be done by GitHub.

Local clones: anyone with an old clone must re-clone, or run `git fetch --all` and reset each branch to the new origin. Old clones still contain the secrets, so the owner should treat them as not clean.

## 6. What breaks

- Open PRs (17 at the time of writing). Each PR branch that contains a removed commit gets new SHAs. The PR diff will show the rewritten commits. Each PR must be rebased onto the new main: `git rebase --onto origin/main <old-base-sha> <branch>`, then force-push that PR branch. Do this per PR; it is not automatic.
- Commit SHAs cited in docs, issues, or PR comments will no longer match. Check `docs/` for SHA references before the push.
- Forks: the repo reports 0 forks. If one exists, it keeps the old history and must be re-synced by its owner.
- CI caches and any tags that point at rewritten commits move with the rewrite. Tags are rewritten too. Re-check release tags.
- Nothing on production depends on git history. The rewrite does not change the running app.

## 7. Owner actions

Rotate or confirm each item. Items marked "confirmed" are from the owner's statement that production webhook secrets are rotated.

1. Production webhook secrets (`.appointment-webhook-secret`, `.rag-webhook-secret`): confirmed rotated. Confirm that the old values are no longer accepted by any service.
2. Anything in `desk.log`: not checked. Rotate any token or key that may be in it unless you confirm it was never a live value.
3. Anything in the four archives and in `server/routes/webhook-routes.ts.backup`: not checked. Run step 3 and rotate any live value found.
4. Every value named in the gitleaks report from step 3: rotate unless you confirm it is a test or a dead value.
5. Confirm that nothing else in history is live. Check the list of env variable names that appear in history against the production secret store.

## 8. Execute steps (after approval)

1. Owner approves sections 2 and 5.
2. Owner completes section 7.
3. Run section 3 and send the redacted report to the owner.
4. Run section 4 in a fresh mirror clone and run the verify commands.
5. Owner runs section 5 with the owner's own credentials.
6. Rebase the 17 open PRs (section 6). Each PR author or the owner does this.
7. Add a guard so the files do not come back: a gitleaks check in CI and a pre-commit hook. Track that as a separate change.

## Decisions recorded in this plan

- 2026-11-15: the four issue #133 paths are included in the removal list as recommended, not required. Owner can drop them.
- 2026-11-15: all branches must be rewritten, not only main.
- 2026-11-15: no content scan has been run. It is a required step before the push.
