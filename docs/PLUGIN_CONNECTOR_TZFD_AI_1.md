# Plugin connector contract: tzfd-ai/1

Status: hosted side implemented in `server/integrations/plugin-hosted/` (issue #401, H1). The plugin side is `includes/class-tzfd-ai-connector.php` in `masterleeaus/Titan-Zero-Trades-Front-Desk`, which documents the same wire format in `docs/AI-SERVICE-CONNECTOR-CONTRACT.md`. Both sides must change together. Contract tests: `tests/integrations/plugin-hosted/`.

## Versioning and deprecation

- The version is in the `X-TZFD-Contract` header and the body `contract` field. Both must read `tzfd-ai/1`.
- A breaking change gets a new version (`tzfd-ai/2`). `tzfd-ai/1` keeps working for at least one release after `tzfd-ai/2` ships.
- Adding a feature to the allowlist is not breaking. Removing one is.
- Consent version: `tzfd-ai-consent-1`. A changed disclosure needs a new consent version and a fresh grant.

## Request

`POST` over https. `Content-Type: application/json`.

| Header | Value |
|---|---|
| `X-TZFD-Contract` | `tzfd-ai/1` |
| `X-TZFD-Site` | site id, `^[A-Za-z0-9_.-]{1,64}$` |
| `X-TZFD-Timestamp` | Unix seconds |
| `X-TZFD-Nonce` | 32 lowercase hex characters, new per request |
| `X-TZFD-Signature` | `sha256=` plus lowercase hex HMAC-SHA256 of `<timestamp>.<nonce>.<body>`, keyed with the site secret |

Body, at most 16 KB:

```json
{"contract":"tzfd-ai/1","site":"<site id>","feature":"faq.answer",
 "consent":{"version":"tzfd-ai-consent-1","scopes":["faq.read"]},
 "payload":{ ... }}
```

The body is signed as the exact bytes sent. The secret is never sent in a header, URL or body.

## Response

Body-level responses have HTTP 200 and a body of at most 64 KB:

```json
{"contract":"tzfd-ai/1","site":"<site id>","status":"ok","data":{ ... },
 "usage":{"tokens_in":0,"tokens_out":0,"embedding_tokens":0,"cache_hit":false}}
```

Headers `X-TZFD-Timestamp`, `X-TZFD-Nonce` (echoes the request nonce) and `X-TZFD-Signature` (over `<timestamp>.<nonce>.<body>`) are required on every body-level response.

Body statuses, the only values the plugin accepts: `ok`, `allowance_exhausted`, `service_error`, `contract_unsupported`.

## Rejections and the status used

| Check (in order) | Result |
|---|---|
| Method is not POST | HTTP 405, unsigned |
| Contract header is not `tzfd-ai/1` | HTTP 400, unsigned, `contract_unsupported` |
| Site id, timestamp or nonce malformed, or timestamp more than 300 s from server clock | HTTP 401, unsigned |
| Site id unknown, or its stored secret is shorter than 32 characters | HTTP 401, unsigned |
| Raw body over 16 KB | HTTP 413, unsigned |
| Signature does not match | HTTP 401, unsigned |
| Nonce already seen for this site inside the window (replay) | HTTP 401, unsigned |
| Body is not JSON, or `contract` is wrong, or `feature` is not allowlisted, or consent version is wrong | HTTP 200, signed, `contract_unsupported` |
| Body `site` names a different site (tenant mismatch) | HTTP 200, signed, `service_error` |
| Required scope not claimed by the body and granted on the server record | HTTP 200, signed, `service_error` |
| No handler for an allowlisted feature, or handler returns an unknown status | HTTP 200, signed, `contract_unsupported` or `service_error` |
| Handler throws | HTTP 200, signed, `service_error`; the error text is not returned |

Unsigned rejections are safe for the plugin: it treats a missing or invalid signature as `invalid_response` and uses local behaviour.

## Feature allowlist and scopes

| Feature | Scopes required |
|---|---|
| `faq.answer` | faq.read |
| `faq.embed_query` | faq.read |
| `faq.suggest_batch` | faq.read |
| `insight.monthly` | reports.read |
| `assistant.turn` | faq.read, customer.read |
| `agent.run` | booking.read, booking.write, customer.read |

A scope must be both claimed in the body and granted on the server-side site record. The model or the browser cannot grant itself a scope.

## Tenant binding

- The tenant id comes only from the server-side site record for the verified `X-TZFD-Site` value.
- The body `site` field must equal that site id. A mismatch is refused.
- Nothing from a query string, a form field or a browser value sets the tenant.

## Replay window

- The nonce is recorded for the site after the signature is proven, and kept until 300 s after its timestamp.
- The in-memory store in the code is for one process only. A deployment with more than one instance needs a shared store with the same semantics.

## Origin

`Origin` and `Referer` are not caller identity. Only the signature and the site binding count.

## Server obligations

- Check nonce replay within the window.
- Check tenant scope from `X-TZFD-Site`.
- Enforce budgets before any provider call (per-company budgets belong to the AI runtime, #329 and #335).
- Sign every body-level response.

## Known gaps

- Site records are supplied by a registry. Owner-initiated pairing and the Central membership check are issue #477 item 3, not done here.
- No budget or rate limit yet. Those come with the AI runtime.
- Feature handlers are injected. None are wired to the AI runtime yet.
