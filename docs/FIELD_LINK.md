# Desk to Titan Zero Field link

Status: scaffold. Field does not yet expose the endpoints below or verify the signature scheme. Until it does, the client cannot succeed against a real Field. Every endpoint path is **ASSUMED**.

## What it is

One governed client, `server/integrations/field-link/client.ts`, is the only place Desk calls Titan Zero Field over HTTP. It is built on:

- `server/integrations/field-link/vendor/`: Field's native workforce contracts (`workforce-native/contracts.ts`) and the runtime authority gateway with its local import closure, copied unchanged at commit `b6fed9da4ab411dc8f147b30e418854e015b216c`. See `vendor/NOTICE.md`.
- `server/integrations/field-link/company-map.ts`: the Desk company_id to Field account_id mapping, with a fail-closed default.
- `tests/integrations/field-link.test.mjs`: fake-fetch tests (run with `node --test tests/integrations/field-link.test.mjs`).

Configuration (all from the environment, none in the repo):

| Variable | Meaning |
|---|---|
| `FIELD_LINK_BASE_URL` | `https://` URL of Field, or `http://127.0.0.1` / `http://localhost` for local development only |
| `FIELD_LINK_KEY_ID` | Identifies the Desk key on Field. Not secret |
| `FIELD_LINK_SECRET` | HMAC secret, at least 32 characters. One per Desk and Field pair in the target design |
| `FIELD_LINK_TIMEOUT_MS` | Optional. Default 5000, maximum 30000 |

If none are set, `readFieldLinkConfig` returns null and callers must treat the link as off.

## Guarantees in the client

- Plain http is refused except to `127.0.0.1` and `localhost`. URLs with credentials or query strings are refused.
- Redirects are refused: the request uses `redirect: "error"`, and any 3xx response is an error (`field_link_redirect_refused`).
- Every request has a timeout, which aborts the fetch (`field_link_timeout`).
- Each request is signed. Headers:
  - `X-Desk-Key-Id`: the key id.
  - `X-Desk-Timestamp`: Unix seconds.
  - `X-Desk-Signature`: base64 HMAC-SHA256 over `timestamp + "." + METHOD + "." + path + "." + sha256hex(body)`. The path includes any query string. The body is the exact JSON string sent, or empty for GET.
  - `Idempotency-Key`: set on writes, equal to the idempotency key in the body.
- Errors have a code and an HTTP status only. The message is the code. Neither the secret, the request body nor the response body is included, and the client logs nothing.
- Tenant resolution: the caller passes the Desk company_id from a server-side record. The client resolves the Field account through `FieldCompanyMap.lookup`. Unmapped, empty or prototype-named keys throw `field_link_tenant_not_mapped` before any request is sent. The company is never derived from a user id, a request, a header or a session.

## Assumed endpoints (ASSUMED: Field does not have these)

| Client method | Method and path | Purpose | Field counterpart today |
|---|---|---|---|
| `createBookingRequest` | `POST /api/v1/integrations/desk/booking-requests` **ASSUMED** | Create a booking request from a qualified Desk lead | Thin wrapper over the logic behind `POST /api/v1/booking-requests`, which requires a session cookie |
| `getBookingRequest` | `GET /api/v1/integrations/desk/booking-requests/:id` **ASSUMED** | Read one booking request that Desk created | Field has `GET /api/v1/booking-requests`, session only |

The create body (ASSUMED) is: `external_ref {source: "titan-desk", tenant_ref, record_id}`, `account_id`, `idempotency_key`, `customer {name, phone?, email?}`, `service_address {line1, suburb, postcode}`, `requested_service`, `requested_window {start, end}`, `notes` (max 2000 characters), `consent {captured_at, basis}`.

Responses (ASSUMED): 201 with `{booking_request_id, status}`. 200 with `deduplicated: true` on replay of the same idempotency key. 401 `invalid_signature`. 403 `tenant_not_mapped`. 409 `idempotency_conflict`. 422 `validation_error`. The client maps these to `field_link_auth_rejected`, `field_link_forbidden`, `field_link_conflict` and `field_link_validation_failed`.

The Field contract operations in `vendor/workforce-native/contracts.ts` (for example `clients.list`, `booking_requests.list`, `estimates.create`) are not reachable through this client. They are session-scoped routes in Field and are listed here for reference only.

## Migration from the direct database link

The direct link (Desk's `titan_desk` role with SELECT on Field's `clients`, `jobs`, `visits`, `booking_requests` and `work_orders`) is the current state. It is to be replaced in six steps. Do not revoke before step 1 is complete, because an unknown job would fail silently.

1. **Inventory (read-only).** On the database server, list grants on the five tables (`\dp`), roles (`\du`) and connections (`pg_stat_activity.application_name`). Use `pg_stat_statements` if it is enabled. Find every Desk job or cron that reads these tables.
2. **Freeze grants.** No new grants on Field base tables. Desk's existing SELECT stays until step 5.
3. **Read-only views.** Field creates narrow views, for example `desk_read.clients_min`, with only the columns Desk needs, filtered to the mapped account. Desk reads the views, not the base tables. Column names need checking first.
4. **Shadow.** Field implements the ASSUMED endpoints. Desk writes booking requests through the signed client and still reads through the existing grant. Compare the two for an agreed period.
5. **Cut over one query at a time.** Move each Desk read from the view to the API, one query at a time, behind a per-query rollback switch. Keep the grant until the inventory shows zero queries for two weeks.
6. **Revoke and remove.** Revoke `titan_desk` SELECT on the base tables, then drop the views once unused. Record the revocation date and the checks that passed.

Also note: the Desk workforce runtime in `server/integrations/workforce-runtime/wire.mjs` has its own HMAC scheme (`x-titan-local-signature`, a different canonical string). It is not used for Field. The two schemes should be unified before a second Field-facing client is added.

## What Field must add before this works

1. **Service-to-service auth.** Field has none today. Its `/api/internal/*` routes compare a static `x-api-key` with `!==`, which is not constant-time, so do not reuse that pattern. Required:
   - Verify `X-Desk-Signature` with `crypto.timingSafeEqual` over the canonical string above.
   - Reject timestamps more than 300 seconds from server time.
   - Hold the secret in the secret store, never in the repository or `.env.example`. One secret per Desk and Field pair.
   - Bind each key id to exactly one Field account on the server. Compare the body `account_id` against that binding and refuse on mismatch. Do not trust the body alone.
   - Enforce the idempotency key (replay returns the first result; reuse with a different body returns 409).
2. **The endpoints above**, as thin wrappers over the existing booking-request create and read logic, with the same validation and tenant scoping as the session routes.
3. **Read projections** (migration step 3) if Desk still reads Field data after cut-over.
4. **Reconcile the database picture.** Field's `infra/compose.prod.yml` runs its own `postgres:16`, which conflicts with a shared-server report. Confirm which is true before step 1.

## Known gaps

- Field's session cookie is the only auth for its v1 APIs. This client cannot succeed until item 1 above exists.
- No outbox exists in Field, so Field to Desk events (webhooks) are not part of this link.
- The Field source commit is pinned in `vendor/NOTICE.md`. Updating the vendored copy means copying again and updating that hash.
- The licence terms of the Field source were not analysed. The Field root has no LICENSE file.
