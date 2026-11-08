# Titan Zero — Pass 9 | AGENTLABS DESK

## Application target

- App: Titan Desk (AgentLabs), /home/admin/apps/desk
- This ZIP is cumulative source work based on the supplied Pass 8 archive.
- Archive paths are rooted at the target app's source root; there is no nested `field/` or `desk/` prefix.
- **DO NOT unzip directly over a live deployment.** First stage against a verified current server checkout, compare, test and deploy with a rollback plan.
- This is the supplied AgentLabs source backup; several original deployment/config files are still missing.

## Pass 9 changes

- Configured, signed, read-only capability handshake over loopback HTTP between existing local ports 3000 (Field) and 3001 (Desk).
- HMAC SHA-256 request/response signatures; 180-second clock skew tolerance; no raw secrets or PII in responses.
- Only `127.0.0.1` and `::1` HTTP accepted as local peers; no nonlocal host, URL injection or redirects.
- Existing communication/reply transports can resolve their default same-host endpoints **only when `TITAN_LOCAL_LINK_ENABLED=1`**.
- Existing shadow-only workflow and DB-agent dependency ports remain unchanged; no SMS, email, voice or business mutation is activated.
- No application database code, migrations, identity mapping or event ledger were changed.

## Environment settings (both applications)

`TITAN_LOCAL_LINK_ENABLED=1` (default disabled)

`TITAN_LOCAL_LINK_SECRET` (same independently generated >=32-byte high entropy secret in both apps)

Optional non-default local origin override: `TITAN_LOCAL_FIELD_ORIGIN=http://127.0.0.1:3000`

The existing per-direction bridge secrets/feature flags are **separate** from the read-only link secret; do not reuse passwords or expose secrets in logs.

## Testing / validation

- Combined Pass 3–9 contract regression: 119 / 119 passed.
- Independent app-local tests (Field 3, Desk 3): 6 / 6 passed.
- Tests are only on isolated source copies and local in-process/mock HTTP, **not** on the production server.
- On a staged install with environments configured, `node scripts/titan-local-link-check.mjs` performs a signed, read-only peer probe.
- The check returning `reachable=true` proves only transport and signature verification; it does not prove database mapping or production delivery.

## Important separate workstreams

Other agent: Field↔Desk PostgreSQL company/user mapping, tenant-scoped authorisation, durable event ledger, consent evidence, production persistence and migration governance.

This agent: application source reconciliation, provider adaptation, caller/callee contract tests and safe staged deployment preparation.

## Existing functionality preserved

All Pass 8 code and handoff assets retained, except strictly listed changed files; every inherited archive member was compared byte-for-byte. No existing source was removed.

See `DELTA_MANIFEST.json` for precise file changes and checksums.
