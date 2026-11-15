# Central integration: decision brief

Issues: #53, #193, #195, #196
Date: 2026-11-15
Status: brief only. No code changed. No owner decision is made here.

## Where things stand

- The Central code under `server/infrastructure/central-sso/` and `server/infrastructure/central-oidc/` has mocked tests only.
- No runtime code outside those two folders imports these modules. Routes are not mounted, so the existing login is unchanged.
- Live Central has not been checked. Central's contract docs (EVENTS.md, CONFIG.md, LAUNCHER_OIDC.md) are not in this repo.
- Work on #53, #193 and #196 is blocked until the owner answers D1 to D5 below.

## Decisions needed

Each one is a separate question. Answer in any order.

### D1. Which signature scheme do Central outbox events use?

Two verifiers exist and they do not agree.

- Option A: HMAC over the raw body, header `t=<unix>,v0=<hex>`, signed over `t.rawBody`. Code: `server/infrastructure/central-sso/outbox-events.ts`. Same shape as the repo's other webhook checks.
- Option B: HMAC over the canonical JSON of the envelope (sorted keys, `signature` removed). Code: `server/infrastructure/central-oidc/signed-events.ts`. Its comment says it mirrors Central's EVENTS.md.

Cost: the option not chosen is deleted with its tests. Option A needs Central to sign the raw body. Option B needs Central's signer to match canonical JSON exactly (key order, number format).

Recommendation: Option B, but only if Central's signer or EVENTS.md confirms canonical JSON. The signer is on Central's side, so match Central rather than asking Central to change. Keep one verifier, not two.

### D2. Which feature flag reader do we keep?

Two readers exist. Neither is used.

- Option A: snapshot-based, `server/infrastructure/central-sso/feature-flags.ts`. Reads a local snapshot. Nothing creates or loads a snapshot today.
- Option B: request-based, `server/infrastructure/central-oidc/feature-flags.ts`. Calls Central's flag endpoint through the service client. One second timeout, 60 second cache, declared default on any failure.

Today both return the declared default, because the declared flag list is empty.

Cost: Option A needs a sync job and a freshness rule. Option B depends on Central's flag read endpoint, which is not live. The path in code is assumed, not verified.

Recommendation: Option B. Issue #196 describes a live read with declared defaults, and it needs no sync job. Remove the other file when Option B is confirmed.

### D3. Where do the in-memory records live?

Four stores are in memory only:

- processed event ids and last sequence per tenant (`outbox-events.ts`)
- processed-event set (`createMemoryProcessedStore` in `signed-events.ts`)
- single-use nonce ledger (`link-assertion.ts`)
- pending sign-in transactions (`oidc-flow.ts`)

- Option A: keep them in memory. Fine for one process on staging. A restart forgets them, so an event can apply twice and a sign-in in progress is lost.
- Option B: a durable Postgres store, one additive table per store, with the claim in the same transaction as the handler. Needs a migration plan (additive and reversible, per project rules) and a rollback step.

Cost: Option B is one or more migrations plus tests. The pending migration in `docs/pending/` belongs to another lane and must be coordinated.

Recommendation: Option B before any production use or second instance. Option A is acceptable on staging only if it is written down as a limit. Decide for all four stores together.

### D4. Check membership live, or cache it?

Issue #195 says Central owns membership, and revoked access must be refused.

- Option A: ask Central on every protected request. Revocation is immediate. If Central is down, users are locked out.
- Option B: cache membership in Supercharged with a maximum age. Users keep working through a short Central outage. Revocation takes effect after the maximum age.

Cost: Option A adds a Central call per request. Option B adds a stale window that must be explained to users and tested.

Recommendation: Option B with a short cap (5 minutes is a reasonable start). Past the cap, fail closed. This matches the "fail closed" rule in #53. The cap value is the owner's choice.

### D5. Which claim carries the company id?

`CENTRAL_COMPANY_CLAIM` has no default in code. Issue #195 says "the verified org claim", but that is not verified against Central.

- Option A: use the claim name Central declares in its contract.
- Option B: use a claim name agreed with the Central operator, separate from the org claim.

Cost: none if answered before staging. A wrong name makes every sign-in fail closed, which is safe but blocks testing.

Recommendation: Option A. Confirm the exact name with the Central operator. Do not add a fallback default.

### D6. Which config names do we keep?

Two name sets exist for the same sign-in client and origin:

- `central-sso`: `CENTRAL_OIDC_ISSUER`, `CENTRAL_OIDC_CLIENT_ID`, `CENTRAL_OIDC_CLIENT_SECRET`
- `central-oidc`: `CENTRAL_ORIGIN`, `TITAN_DESK_OIDC_CLIENT_ID`, `TITAN_DESK_OIDC_CLIENT_SECRET`

Recommendation: keep the `central-sso` names. That module holds the full sign-in flow (discovery, start, callback, sign-in). Retire the `central-oidc` names with D1 and D2.

## Owner-only values

These must come from the Central operator and go into the secret store. Names only here. Do not paste values into chat, issues or docs.

- `CENTRAL_ORIGIN`
- `TITAN_DESK_AUDIENCE`
- `CENTRAL_OIDC_CLIENT_ID` and `CENTRAL_OIDC_CLIENT_SECRET` (or the `TITAN_DESK_OIDC_*` pair, per D6)
- `CENTRAL_COMPANY_CLAIM` (see D5)
- `TITAN_CENTRAL_EVENT_SECRET`
- `CENTRAL_OUTBOX_HMAC_SECRET` (see D1)
- The Central flag endpoint contract: the path `/internal/v1/config/{environment}/{key}` in code is assumed (see D2)

Also present, same rule: `CENTRAL_LINK_ISSUER`, `CENTRAL_LINK_AUDIENCE`, `CENTRAL_LINK_KEY_ID`, `CENTRAL_LINK_PRIVATE_KEY`, `CENTRAL_LINK_SIGNING_KEY`, `CENTRAL_LINK_SIGNING_KID`, `CENTRAL_SERVICE_CLIENT_ID`, `CENTRAL_SERVICE_CLIENT_SECRET`, `CENTRAL_API_BASE_URL`, `CENTRAL_TOKEN_URL`.

## After the decisions

Once D1 to D6 are answered, one lane can:

1. Remove the losing verifier, reader and config names.
2. Add the durable store migration (D3), with rollback.
3. Mount routes behind `CENTRAL_SSO_ENABLED`.
4. Run a staging check against live Central.

Nothing in this brief is a behaviour decision yet. Decisions go into the checklist once the owner chooses.
