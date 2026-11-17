# InterServer release and deployment boundary

**Repository class:** saas  
**Live destination:** superchargedat.work

Node/Vite application with existing multi-stage Dockerfile; deploy an immutable container to its own VPS service.

## Release policy (safe starting state)
1. Open a PR and pass the repository's existing CI. The new candidate workflow provides an additional **manual release gate** and records what was checked; it does not waive existing failed CI.
2. Deploy to a distinct InterServer staging location after validating exact hostname, OS, webroot, service layout and runtime configuration.
3. Run HTTP/browser/E2E checks, tenant isolation, integrations, migrations and rollback rehearsal. Do not consider an isolated build proof of production readiness.
4. Promote **the same immutable tested revision** to production after a GitHub `production` environment approval. Configure required reviewers and block self-review where supported.
5. Post-deploy smoke checks and automatic/manual rollback from retained releases. Keep credentials only in GitHub environment secrets or a secure server-side secret store.

## Security and configuration
- Use separate unprivileged deploy users for marketing and each SaaS service; never deploy as root or grant the runner a general DirectAdmin administrator account.
- Use SSH deploy keys and **pinned SSH host keys** in GitHub environment secrets. Never run `ssh-keyscan` in the workflow and implicitly trust its output.
- Use short-lived or rotated credentials; scope filesystem write rights to that application's dedicated staging/release directory.
- Do not commit `.env`, database passwords, SSH private keys, API tokens or host-level configuration. Restrict access to production GitHub environments.
- Keep persistent uploads, databases, logs, and customer files **outside deploy release directories**.
- Include signed webhooks, idempotent migrations, backups and compensating transactions where services perform financial/booking writes.
- No production workflow is enabled by this PR. Live destination mapping, DNS/TLS verification, runner-to-server SSH validation and independent staging tests are prerequisites.

## InterServer inventory to confirm
- Actual DirectAdmin domain document root, account username and whether SSH/symlinks are permitted.
- VPS IP/SSH host key, application runtime (systemd, Docker Compose or other), isolated service paths and ports.
- Actual SaaS domain routing: `scheduledat.work`, `sortedat.work`, `skilledat.work`, `superchargedat.work`. Central's host name is unconfirmed.
- Database engine/owners, exact migration chain, backup restore point, proxy/TLS configuration, health endpoints and queue/job worker stop/start order.

## Rollback
Retain the last known-good artifact and database snapshot; reversibility of schema changes must be explicitly certified. Stop rollout if checks fail and restore the previous revision where schema compatibility permits. Do not use a blind `git pull` in the production webroot.
