# Secret rotation runbook: webhook secrets (issue #2)

Status: for the repository owner. Issue #2 stays open until the rotation (section 3) and the history rewrite (section 5) are both done.

Why: two webhook secret files were committed to git. The untracking commit `ba70cf9` ("Stop tracking webhook secret files") is on `origin/main`, but the original commit `27c969d` ("Initial import of desk app") still holds both files. Anyone with a clone or fork can read the old values. Treat the old values as compromised.

Scope: this runbook covers only the two files below. Other secrets that the code search matched (Stripe, Paystack, Razorpay, ElevenLabs, and so on) are not in scope.

## 1. The secrets (names only)

- Appointment webhook secret. File: `.appointment-webhook-secret`. Environment variable: `APPOINTMENT_WEBHOOK_SECRET`.
- RAG webhook secret. File: `.rag-webhook-secret`. Environment variable: `RAG_WEBHOOK_SECRET`.

Values are never written in this document, in commits, or in chat.

## 2. Where each secret is read

Appointment secret, `server/services/appointment-elevenlabs-tool.ts`:
- `resolveAppointmentWebhookSecret()` checks, in order:
  1. the `APPOINTMENT_WEBHOOK_SECRET` environment variable;
  2. the file `.appointment-webhook-secret` in the process working directory (`process.cwd()`);
  3. only if `NODE_ENV` is `development` or `test`, a labelled dev-only value;
  4. otherwise it throws. Production fails closed and does not generate a secret.
- The value is cached in memory on first use. A restart is needed after any change.
- Token check: `validateAppointmentWebhookToken()`, used by `POST /api/webhooks/elevenlabs/appointment/:token/:elevenLabsAgentId` in `server/routes/webhook-routes.ts`. A wrong token gets HTTP 401.
- Other readers of the same value: `server/services/elevenlabs.ts`, `server/services/play-audio-elevenlabs-tool.ts`, `server/services/openai-voice-agent/hydrator.ts`, `server/services/sip-transfer-resync.ts`.

RAG secret, `server/services/rag-elevenlabs-tool.ts`:
- `getRAGWebhookSecret()` checks, in order:
  1. the `RAG_WEBHOOK_SECRET` environment variable;
  2. the file `.rag-webhook-secret` in the process working directory;
  3. if the file is missing, a value derived from `JWT_SECRET` (or `ELEVENLABS_AGENT_SECRET`), which is then written back to the file;
  4. if neither key exists, a random value, which is also written back to the file.
- The value is cached in memory on first use. A restart is needed after any change.
- Token check: `validateRAGWebhookToken()`, used by `POST /api/webhooks/elevenlabs/rag-tool/:token/:agentId` in `server/routes/webhook-routes.ts`. The token comes from the URL or the `x-rag-token` header.

Warning for the RAG secret: if you only delete the file, the code can recreate the same value from `JWT_SECRET`. Set `RAG_WEBHOOK_SECRET` to a new random value so that the environment variable wins.

## 3. Where the values are set in production

- `ecosystem.config.cjs` sets only `NODE_ENV=production` and `PORT=5000`. It does not set either secret. The values come from the environment of the process that starts the app, or from the files in the app directory.
- `Dockerfile` uses `WORKDIR /app`. `.dockerignore` excludes both files, so they are never copied into the image. In a container, use the environment variable, or mount a file at `/app/.appointment-webhook-secret` or `/app/.rag-webhook-secret`.
- `docs/DEPLOY_PACK.md` says `APPOINTMENT_WEBHOOK_SECRET` must be set, "otherwise the secret changes on restart". This is out of date. The current code fails closed instead of generating a value. The code is the source of truth.
- The owner must confirm where the production host (garonhome.local) and the container definition get these values. This was not verified from the repository.

## 4. Rotation steps (owner)

1. Generate two new random values on your own machine, for example with `openssl rand -hex 32`. Save them in your password manager. Do not paste them into chat, issues, or commits.
2. Decide the window. Each ElevenLabs tool that calls these webhooks will fail with 401 from the moment the server changes until the agent configuration is updated. Do steps 3 and 4 close together.
3. Update the ElevenLabs agent tool configuration so that each tool sends the new token. The token is the `:token` path segment (or the `x-rag-token` header for RAG).
4. On production, set `APPOINTMENT_WEBHOOK_SECRET` and `RAG_WEBHOOK_SECRET` to the new values, using the environment method you confirmed in section 3. Remove any old file, or overwrite it with the new value and file mode 600. Do not write these values into git.
5. Restart the app so the in-memory cache reloads. For example, `pm2 restart agentlabs --update-env`, or recreate the container.
6. Run the checks in section 6.
7. Record the date, the person, and the fact that the old values are revoked, in your own ops log.

## 5. Remove the old files from git history (owner decision)

This rewrites history and needs a force-push. Only the owner can decide this. Do not run it without that decision.

Facts that matter for the decision:
- The commit `27c969d` that holds the files is contained in 66 remote branches.
- A force-push affects every collaborator. Each one must re-clone or reset after the rewrite.
- Removing the files from history does not remove copies that already exist in forks, clones, or GitHub's cached views. If the repository was ever public or forked, ask GitHub Support to purge cached objects.
- Branch protection on `main` may block the force-push. The owner may need to allow it for this one push.

Steps, to be run by the owner in a fresh clone, not in a working copy:

```
git clone --mirror <repo-url> scrub.git
cd scrub.git
git filter-repo --invert-paths --path .appointment-webhook-secret --path .rag-webhook-secret
git remote add origin <repo-url>
git push --force --all origin
git push --force --tags origin
```

`git filter-repo` must be installed separately. The `--mirror` clone is only used to rewrite, so do not push `refs/pull/*`.

After the push:
- Check in the new clone that `git log --all -- .appointment-webhook-secret .rag-webhook-secret` prints nothing.
- Ask every collaborator to re-clone. Do not merge old clones back in.
- Rotate the secrets (section 4) whether or not you rewrite history. The values are already public.

## 6. Confirm the new values work

Automated test:
- Run `node --test --experimental-transform-types tests/security/appointment-secret-fail-closed.test.mjs`. It covers these behaviours for the appointment secret: the environment variable beats the file, production fails closed with neither, and the dev-only value is used only in development or test. It does not use your real secret. It was run during this change and passed 6 of 6.
- No dedicated test covers the RAG secret resolution or the RAG token check. Use the live check below for RAG.

Live check (replace the placeholders; keep the values in your shell only):

```
export NEW_RAG_SECRET='<paste in your shell, not in chat>'
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://<host>/api/webhooks/elevenlabs/rag-tool/not-the-token/<agentId>" -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://<host>/api/webhooks/elevenlabs/rag-tool/$NEW_RAG_SECRET/<agentId>" -H 'Content-Type: application/json' -d '{}'
```

- A wrong token must return 401.
- The new token must not return 401. A valid token with an empty body may run a real request, so use a test agent id if you have one.
- Repeat with the old value. It must return 401.
- Repeat the same pattern for `/api/webhooks/elevenlabs/appointment/...` with the appointment value.

## 7. What to do with the old values

- Treat both old values as compromised. Do not reuse them, in any environment.
- If the old RAG value was derived from `JWT_SECRET` (the code did this when no file existed), changing only the file does not help. Set `RAG_WEBHOOK_SECRET` as in section 4.
- Whether `JWT_SECRET` also needs rotation is the owner's decision. Rotating it signs out users and invalidates tokens.
- Delete the old copies from local working directories and backups.

## 8. Owner decisions still open

- Whether to force-push the rewritten history (section 5), and when.
- Whether the production secrets live in an environment variable or a file (recommended: environment variable).
- Whether to rotate `JWT_SECRET` as well.
- The window for updating ElevenLabs tool configuration.
- Update or remove the out-of-date note in `docs/DEPLOY_PACK.md` (section 3).
