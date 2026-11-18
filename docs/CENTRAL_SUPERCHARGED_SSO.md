# Supercharged — Central SSO adapter integration

Central issue #25 requires real Supercharged authentication with its own
existing user IDs and company context. This pass adds a disabled, server-only
central selection validator, exact company/identity resolution adapter,
tenant-scoped PostgreSQL lookup, and wrapper for the existing native JWT
issuer. Existing user login is unchanged.

The resolver requires an independently verified Central issuer/subject,
current company mapping, live product entitlement, exactly one local
`desk_central_identity_links` row, a current user-company match, and an
active account. Company context travels through the existing `withTenant`
transaction, which sets `app.company_id` and a restricted role.

The optional migration is intentionally **not applied**. Verify live
Supercharged `users` schema, actual tenant role, SQL function ownership and
migration runner before applying it; no direct product connection is
enabled. Never accept browser-controlled `authority:'central-verified'`
as true authentication: that value must be produced internally only after
the actual OIDC callback and Central access check.

Outstanding: real OIDC/PKCE callback, verified company selection, durable
company-linked token revocation, upstream client registration, and
end-to-end tenant separation. Do not close issue #25 or bypass native login.

## Sign-in and service adapter (issues #53, #134, #193, #194)

Status: code and mocked tests only. **Live Central was NOT verified.** No
staging run has happened, and no production cutover is implied.

### Feature flag and settings

Everything is off unless `CENTRAL_SSO_ENABLED=true`. Values come from
environment variables only. Nothing is read from `.env` files in code, and no
secret is stored in the repo.

| Variable | Purpose |
| --- | --- |
| `CENTRAL_SSO_ENABLED` | Must be exactly `true`. Default off. |
| `CENTRAL_OIDC_ISSUER` | Central issuer, https. Discovery is read from `<issuer>/.well-known/openid-configuration`. |
| `CENTRAL_OIDC_CLIENT_ID` / `CENTRAL_OIDC_CLIENT_SECRET` | Sign-in client. From the Central operator, into the secret store. |
| `CENTRAL_OIDC_REDIRECT_URI` | Callback URL registered with Central. https, or http on localhost only. |
| `TITAN_DESK_AUDIENCE` | Supercharged's per-app audience. Must appear in the ID token `aud`. Value from the Central operator. |
| `CENTRAL_COMPANY_CLAIM` | Name of the verified ID-token claim holding the Supercharged company UUID. Required, no default. |
| `CENTRAL_SERVICE_CLIENT_ID` / `CENTRAL_SERVICE_CLIENT_SECRET` | Client-credentials pair for service calls. Set together. |
| `CENTRAL_API_BASE_URL` | Central API base for service calls, https. |
| `CENTRAL_GLOBAL_LOGOUT_URL` | Global logout target, https. Its parameters are not yet in the repo. |

### Code map

- `server/infrastructure/central-sso/config.ts`: flag and validation.
- `discovery.ts`, `pkce.ts`, `id-token.ts`: discovery, JWKS, PKCE S256, ID token checks.
- `oidc-flow.ts`: start and callback. State is single use and bound to a host-only `__Host-` transaction cookie.
- `sign-in.ts`: joins a verified callback to the existing account resolver and native session gate.
- `service-client.ts`: client credentials, audience-checked token cache, and a guard that refuses tenant selectors.

The flow checks issuer, audience, `azp` when there are several audiences,
expiry, `nbf` and `iat` with 60 s skew, nonce, subject, and the company claim.
It accepts RS256, ES256, and ES384 only. `none` and HMAC are refused.

### Callback and routes

Not mounted. The code exists but no Express route is registered, so the
existing login is unchanged. Route wiring (proposed paths: `/auth/central/start`,
`/auth/central/callback`, logout; not Central-defined) is the next step, to be done
behind the flag once the open items below are closed.

### Monitoring and rollback

- Failure reasons are fixed codes (`state_mismatch`, `audience`, `nonce`, `company_claim`, and so on). Log those codes only.
- Rollback: set `CENTRAL_SSO_ENABLED=false`. Native login is not touched.

### Open items (not in repo, not verified)

1. The Central contract in `Masterleeaus/Central` (`docs/LINKING.md`, `docs/EVENTS.md`, `docs/LAUNCHER_OIDC.md`, `docs/CONFIG.md`, `docs/PRODUCT_REGISTRY.md`, `packages/control-plane/src/applications.ts`) was not reachable from this session, so these details are assumed, not checked.
2. Which ID-token claim carries the company id. `CENTRAL_COMPANY_CLAIM` has no default.
3. Whether the service token request should send `audience` (used here, per issue #194) or `resource` (Logto's name). Central must accept the parameter used.
4. Whether Central issues JWT access tokens. Opaque tokens are refused because the audience cannot be checked.
5. The access-check endpoint for entitlement (issue #194) is not in the repo. `authoriseCentral` in the resolver still needs a real implementation.
6. Global logout parameters and the Central-side `/auth/titan/global-logout` behaviour.
7. The pending-login store is in memory (single process). A shared store is needed for more than one instance.
8. The migration in `docs/pending/` is still unapplied (owned by lane F).

## Issue #53 evidence and owner-only items

Evidence (run in this checkout, mocked, no live Central):

- `node --test --experimental-transform-types tests/infrastructure/central-oidc-*.test.mjs tests/infrastructure/central-sso-*.test.mjs`: 137 pass, 0 fail.
- Discovery, PKCE S256, state, nonce, issuer, audience, `azp`, expiry, `nbf`/`iat` skew, subject and company-claim checks: `central-sso-id-token.test.mjs`, `central-oidc-signin.test.mjs`, `central-sso-http.test.mjs`.
- State mismatch, wrong audience and expired token: `central-sso-id-token.test.mjs` and `central-oidc-signin.test.mjs`.
- Missing, revoked, ambiguous and cross-company links fail closed: `central-sso-account-resolver.test.mjs`, `central-sso-link-query.test.mjs`.
- Feature flag off by default and enabled only by `CENTRAL_SSO_ENABLED=true`: `central-oidc-config.test.mjs`. Routes are mounted only when enabled (`mountCentralSso` in `server/routes/core/central-sso-routes.ts`).

Owner-only, not done here:

1. Verify against live Central (`Masterleeaus/Central` #25, #28, #29). Confirm the company claim name, the audience parameter (`audience` vs `resource`), and whether Central issues JWT access tokens. Live Central was not reached.
2. Logout. No local logout route exists. Adding one touches the session gate and auth, so the owner must approve the design. Global logout parameters are also unconfirmed.
3. Two-company isolation in integration tests needs `TEST_DATABASE_URL` against a real database. Run in CI or staging.
4. Migrations `0018`, `0019`, `0025` are present. Apply only after the live schema check in the section above.
5. The pending-login store is in memory for the single-process path. A shared store is needed before more than one instance.
6. Rollback is `CENTRAL_SSO_ENABLED=false`. Staging run and any production cutover need the owner's sign-off.
