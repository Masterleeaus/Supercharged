# tzfd-ai/1 plugin connector contract

Status: version 1, implemented in `server/integrations/plugin-hosted/` (hosted endpoint, not yet mounted by a router). Covers issue #477 task 1. Staging proof is not yet linked, so this document describes the contract, not a verified live connection.

The plugin side is the Titan Zero Front Desk plugin (`masterleeaus/Titan-Zero-Trades-Front-Desk`), where the PHP signer is `TZFD_AI_Connector::sign()`.

## Request

Method: `POST`. Body: JSON object, at most 16384 bytes (16 KB).

Required headers. Each must appear exactly once. A repeated header counts as missing. Header names are case-insensitive.

| Header | Rule |
| --- | --- |
| `X-TZFD-Contract` | Must be `tzfd-ai/1`. Any other value is refused with 426. |
| `X-TZFD-Site` | Site id, 1 to 64 characters from `A-Z a-z 0-9 _ . -`. |
| `X-TZFD-Timestamp` | Unix seconds, digits only. Must be within 300 seconds of the server clock, in either direction. |
| `X-TZFD-Nonce` | 32 lowercase hex characters. Each nonce works once. |
| `X-TZFD-Signature` | `sha256=` followed by 64 lowercase hex characters. |

Signature: HMAC-SHA256 with the site secret over the ASCII string `<timestamp>.<nonce>.` followed by the raw request body bytes. The body is hashed as received, so the bytes checked are the bytes sent. Comparison is constant time.

Body JSON fields:

- `contract`: must be `tzfd-ai/1`, otherwise 426.
- `site`: must equal `X-TZFD-Site`, otherwise 403 `tenant_mismatch`.
- `feature`: must be on the feature allowlist, otherwise 400 `feature_not_allowed`.
- `consent`: object with `version` set to `tzfd-ai-consent-1` and `scopes` as an array of strings. Each offered scope must be a known scope name, otherwise 400.
- `payload`: JSON object or array. An empty PHP array is sent as `[]` and is accepted.

## Feature allowlist

| Feature | Scopes it needs |
| --- | --- |
| `faq.answer` | `faq.read` |
| `faq.embed_query` | `faq.read` |
| `faq.suggest_batch` | `faq.read` |
| `insight.monthly` | `reports.read` |
| `assistant.turn` | `faq.read`, `customer.read` |
| `agent.run` | `booking.read`, `booking.write`, `customer.read` |

Any other feature name, including prototype names, is refused.

## Consent and scopes

- Scopes the feature does not use are ignored. The plugin sends every granted scope, so extra scopes are not refused.
- The feature receives only its own scopes that were offered.
- If none of the feature's scopes is offered, or an offered scope is not granted by the site administrator, the request is refused with 403 `scope_not_granted`.

## Response

A valid outcome is HTTP 200 with a signed JSON body:

```
{ "contract": "tzfd-ai/1", "site": "<site>", "status": "<status>", "data": {}, "usage": { "tokens_in": 0, "tokens_out": 0, "embedding_tokens": 0, "cache_hit": false } }
```

Response headers: `X-TZFD-Timestamp`, `X-TZFD-Nonce` (echoes the request nonce), and `X-TZFD-Signature`, which uses the same formula as the request.

Allowed `status` values: `ok`, `allowance_exhausted`, `service_error`, `contract_unsupported`. Any other status from a feature becomes `service_error`. `data` is returned only with status `ok`. A reply over 65536 bytes (64 KB) is replaced with a signed `service_error`. A feature that throws also becomes a signed `service_error` with no error text.

## Refusals

Refusals are unsigned JSON: `{ "contract": "tzfd-ai/1", "refused": true, "reason": "<reason>" }`. No feature runs on a refusal.

| HTTP | Reason | When |
| --- | --- | --- |
| 405 | `method_not_allowed` | Not POST |
| 413 | `body_too_large` | Body over 16 KB, checked before any signature work |
| 426 | `contract_unsupported` | Contract header or body contract is not `tzfd-ai/1` |
| 400 | `invalid_request` | Missing or malformed header, invalid JSON, bad consent shape |
| 400 | `feature_not_allowed` | Feature not on the allowlist |
| 401 | `stale_timestamp` | Timestamp outside the 300 second window |
| 401 | `bad_signature` | Bad signature, unknown site, or empty site secret (same answer, so the site list is not revealed) |
| 403 | `tenant_mismatch` | Body site differs from header site |
| 403 | `scope_not_granted` | Required scope not offered or not granted |
| 409 | `replay` | Nonce already used |
| 500 | `internal_error` | Secret or grant lookup threw |

## Origin and Referer

`Origin` and `Referer` are not checked and are not identity. Identity comes only from the signature and the site binding.

## Versioning and deprecation

- The version string is part of the header and the body. Any change that alters a field, a signature input, or a status meaning needs a new version (`tzfd-ai/2`). Version 1 is not changed in place.
- While both versions are live, the endpoint answers each version separately, and a request with an unknown version gets 426.
- The deprecation window and the date for retiring version 1 are an owner decision. They are not set in this document.

## Tests

- `tests/integrations/plugin-hosted/signing.test.mjs`: signature formula checked against PHP-generated vectors in `fixtures/tzfd-ai-v1.mjs`.
- `tests/integrations/plugin-hosted/connector.test.mjs`: each refusal above, replay, edge timestamps, size limits, scope rules, feature failure handling, and the rule that Origin does not grant identity.

Run: `node --test tests/integrations/plugin-hosted/signing.test.mjs tests/integrations/plugin-hosted/connector.test.mjs`
