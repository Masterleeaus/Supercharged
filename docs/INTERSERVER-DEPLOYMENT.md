# InterServer / DirectAdmin deployment architecture — initial release gate

## Role
SuperchargedAt.Work SaaS — own app service(s), voice/inbox workers and database boundaries. Existing Dockerfile is a build candidate, not a deployment decision.

## Hosting inventory
- Provider: InterServer VPS with DirectAdmin control panel.
- DirectAdmin UI: `https://titanzero.io:2222/evo/`. **Control-panel port 2222 is not the SSH deployment port.** Never use the panel password in GitHub Actions.
- Marketing domain: `titanzero.io`.
- SaaS domains are separate `*.at.work` sites; confirm exact DirectAdmin domain ↔ server path and each app runtime before deployment.
- SSH host, SSH port, Unix deployment user, restricted public key, pinned known_hosts key, staging webroot, production webroot, health URL, database environment and app restart commands **are not yet verified**.
- Do not assume the control panel and all At.Work applications run under the same Unix user or VPS.

## Required GitHub environments
Create separate `staging` and `production` environments. Production MUST require manual reviewers and permit releases only from protected `main` or verified tags; repository rules should require passing CI and code review. Store these environment-scoped values (never commit their contents):
- secrets: `INTERSERVER_SSH_HOST`, `INTERSERVER_SSH_USER`, `INTERSERVER_SSH_PRIVATE_KEY`, `INTERSERVER_SSH_KNOWN_HOSTS`
- variables: `INTERSERVER_SSH_PORT` (normally 22; verify), and application-specific release root and HTTPS health URL.
- Use a dedicated unprivileged deploy identity with a single authorised destination, restricted key, no root/sudo, pinned SSH host fingerprint and key rotation plan.
- Keep production service/database secrets on the host in permissions-restricted configuration managed outside Git, not in source, build logs or GitHub artefacts.

## Promotion policy
1. PR → application-specific CI and security checks. Address red checks; do not weaken them to obtain a green badge.
2. Merge approved tested code → versioned immutable release with SHA-256 or other verifiable manifest, source revision and migration list.
3. Stage to an isolated destination. Take database snapshots and prove recovery **before** any migration. Review worker/queue process boundaries.
4. Run full integration and negative tenant-isolation smoke tests, not only syntax/build tests.
5. Require environment approval to promote a tested release to production with a one-step route back to previous known-good service/files and a DB recovery runbook.
6. Confirm real external HTTPS availability, logs, metrics and action receipts. Record deployed version/SHA and audit outcome.

## Deployment restrictions
- **No automatic production deployment is enabled by this initial branch.** There are currently no verified InterServer credentials, app process supervisors or site release roots in the repository.
- `titanzero.io` is a *marketing* site. Do not copy SaaS app source to its `public_html` or deploy WordPress plugin code into it.
- SaaS services need application-specific Node/PHP/container processes and actual database migrations, not generic DirectAdmin File Manager extraction.
- WordPress Free and Pro need separately tested distributable ZIPs, versioned update channels and compatibility tests, not server-wide file synchronisation.
- Never run `rsync --delete` across a live document root; never overwrite uploads, environment files, databases or secrets.
- If deploy identity cannot write release directories and promote an atomic symlink safely, stop and provision it in DirectAdmin/VPS first.

## Required operator verification before enabling live deployment
Record actual public hostname, DirectAdmin domain assignment, remote absolute release directory, webroot/symlink support, Unix user, SSH port and host fingerprint, running app process manager (systemd/Docker/PM2/PHP-FPM), PostgreSQL connection/secrets location, TLS and backup retention. Validate these against server state, then test staging, rollback and locked-down production approval.
