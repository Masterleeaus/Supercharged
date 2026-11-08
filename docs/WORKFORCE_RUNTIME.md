# Workforce runtime adapter

Status: **port and fail-closed default in place. HTTP client written, not enabled. Endpoints ASSUMED.**

The canonical runtime is GitHub `services/workforce`, and it is not in this workspace. This workspace has a runtime module at `server/workforce/runtime/`, but nothing here has been run against the canonical runtime. The adapter is a port (interface) with a disabled default, plus an HTTP client that is built only when configuration is explicitly valid.

## Files

| File | Role |
|---|---|
| `server/integrations/workforce-runtime/port.ts` | `WorkforceRuntimePort` interface, task status enum, input and output types |
| `server/integrations/workforce-runtime/disabled-runtime.ts` | Default. Every method rejects with `runtime_not_configured` |
| `server/integrations/workforce-runtime/http-runtime.ts` | Signed HTTP client. Constructed only from validated config |
| `server/integrations/workforce-runtime/index.ts` | `createWorkforceRuntime(env)`. Never throws; falls back to disabled |
| `server/integrations/workforce-runtime/wire.mjs` | Pure logic: config, URL rules, signing, validation, response parsing |
| `tests/integrations/workforce-runtime.test.mjs` | `node:test`, fake fetch only |

The `.ts` files import pure logic from `wire.mjs`, so the same validation is shared and testable without a build step. The test imports the `.ts` files directly, which needs Node 22.18 or later (type stripping is on by default).

## Using the port

```ts
import { createWorkforceRuntime } from './server/integrations/workforce-runtime/index.ts';

const runtime = createWorkforceRuntime(process.env); // composition root only
const task = await runtime.submitTask({
  idempotency_key: 'lead-followup-br_42-v1',
  company_id: 'co_1',
  workflow: 'lead_followup',
  requested_by: 'user_7',
  resource: { kind: 'booking_request', reference: 'br_42' },
  payload: { note: 'follow up' },
});
```

Methods: `submitTask(task)`, `getTask(id)`, `cancelTask(id)`, `health()`. Each returns a typed result or rejects with a `WorkforceRuntimeError` whose `code` is one of the `WorkforceErrorCode` values in `port.ts`. The error message is only the code. It never includes a URL, header, body or secret.

Nothing in `server/routes.ts`, `server/index.ts` or `client/` calls the adapter yet. Wiring it into a route is a separate change that needs its own review.

## Environment variables

| Variable | Required | Rule |
|---|---|---|
| `TITAN_WORKFORCE_URL` | yes, to enable | `https://` origin, or `http://127.0.0.1:<port>` or `http://localhost:<port>`. No credentials, path, query or fragment |
| `TITAN_WORKFORCE_SECRET` | yes, to enable | 32 or more bytes, no leading or trailing whitespace |

If either is missing or invalid, `createWorkforceRuntime` returns the disabled runtime, and `runtime.reason` holds a fixed code: `runtime_url_missing`, `runtime_secret_missing`, `runtime_secret_invalid`, `runtime_url_invalid`, `runtime_url_insecure` or `runtime_url_not_origin`. The secret is never part of the reason.

The HTTP client refuses redirects (`redirect: 'manual'`, and any 3xx is an error), uses a timeout (default 5 s, range 100 ms to 30 s), limits response bodies to 256 KiB, and sets `cache: 'no-store'`.

## Signing

Every request is signed with the same conventions as the Desk and Field local link (`server/integrations/titan-field/local-link-wire.mjs`): HMAC-SHA256, a `sha256=<hex>` value, a 10-digit seconds timestamp, and a 180-second skew window.

The canonical string is different on purpose. The local-link signer only accepts two fixed GET paths, and `protocol.mjs` does not bind method or path and caps bodies at 8 KiB. The string here is:

```
titan.zero.workforce-runtime.v1
METHOD
PATH
TIMESTAMP
SHA256_HEX(BODY)
```
The signature is HMAC-SHA256 of that string (joined with newlines) under the secret.

Headers: `x-titan-local-timestamp` and `x-titan-local-signature`. Both names are ASSUMED to match what the runtime verifies.

The adapter does not verify responses. Responses are checked for shape only (see below), so a response that is not from the runtime is not detected by signature.

## ASSUMED endpoints (check before enabling)

| Operation | Method and path | Notes |
|---|---|---|
| submit | `POST /v1/tasks` | Body is the validated task JSON. ASSUMED to honour `idempotency_key` |
| get | `GET /v1/tasks/:id` | Response `id` must equal the requested id |
| cancel | `POST /v1/tasks/:id/cancel` | Empty body |
| health | `GET /v1/health` | Must return `{"ok": true}` |

Also ASSUMED: the status set `pending`, `running`, `awaiting_approval`, `completed`, `failed`, `cancelled`; the response field names `id`, `status`, `workflow`, `company_id`, `result`, `error_code`, `approval_reference`; the header names; and the canonical signing string above.

## Approval flow

1. The runtime may stop a task in `awaiting_approval` and return an `approval_reference`.
2. Desk's approvals module (`modules/approvals`, being built) creates and decides the approval. The runtime does not approve itself.
3. The port has no approve method by design.

Open question: how Desk tells the runtime to resume after an approval decision. It is not defined here. Until it is, a task in `awaiting_approval` can only be cancelled through `cancelTask`, and that must be confirmed with `services/workforce`.

## Verify against services/workforce before setting the variables

- [ ] The four endpoints, methods and paths above.
- [ ] Header names and the canonical signing string. Run one signed request against the real runtime and confirm it is accepted.
- [ ] Response field names, status values and error codes. Any mismatch currently becomes `runtime_bad_response`.
- [ ] That `idempotency_key` is honoured on `POST /v1/tasks`.
- [ ] Whether responses should be signed, and if so, the response scheme. Currently not checked.
- [ ] Whether there is a resume path after approval (see above).
- [ ] Replay: requests are valid for 180 s and carry no nonce. Decide whether the runtime needs one.
- [ ] Run the test file and confirm it passes: `node --test tests/integrations/workforce-runtime.test.mjs`.
- [ ] Run a type check on the project's own tsconfig. This copy has no tsconfig, so the files were only checked with ad hoc strict flags.

Do not set `TITAN_WORKFORCE_URL` in any environment until these are checked.
