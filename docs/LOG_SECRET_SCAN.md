# Log Secret Scan

Read-only scan of `server/` for logging calls that may emit secrets or sensitive personal data. No code or checklist was edited. No secret values are reproduced here.

Scan date: 2026-11-03
Scope: `server/` excluding `node_modules` and `vendor`.
Patterns: `console.log|error|warn|info|debug` and `logger.*` calls whose line mentions `apiKey`, `api_key`, `authToken`, `auth_token`, `secret`, `password`, `token`, `Authorization`, `stripe`, `webhook_secret`, `client_secret`, `body`, `req.body`, or `request.body`.

## Totals

| Class | Count | Meaning |
|---|---|---|
| HIGH | 18 | Logs a secret value, or an unredacted request body |
| MEDIUM | 32 | Logs a whole object, response text, or error object that may carry a secret |
| LOW | 187 | Logs a name, id, count, message, or a value already redacted |
| Total | 237 | Matched logging lines |

Of the 237 hits, 25 are in `.js` compiled mirrors of `.ts` sources (services only). Classifications follow their `.ts` twins. Two HIGH hits are in `server/routes/webhook-routes.ts.backup`, a backup file that is not loaded by the server.

## HIGH

| File | Line | Logged expression | Why |
|---|---|---|---|
| `server/routes/auth-routes.ts` | 198 | `logger.info(... OTP Code for ${email}: ${otpCode})` | Password reset OTP written to logs in clear text. Not gated by environment. |
| `server/routes/webhook-routes.ts` | 5986 | `console.warn(... URL token (full): ${urlToken})` | Full webhook token value logged on auth failure. |
| `server/routes/webhook-routes.ts` | 5987 | `console.warn(... Header token (full): ${headerToken})` | Full webhook token value logged on auth failure. |
| `server/modules/widget/public-widget-routes.ts` | 1162 | `console.log(... client_secrets response, JSON.stringify(tokenData))` | Whole ephemeral-token response logged, which carries a usable client secret. |
| `server/routes/webhook-routes.ts` | 962, 1091, 1401, 1712 | `console.log(... Body:, req.body)` | Raw inbound webhook body logged. |
| `server/routes/webhook-routes.ts` | 1149 | `console.log(... Body:, JSON.stringify(req.body))` | Raw inbound webhook body logged. |
| `server/routes/webhook-routes.ts` | 5003, 5568, 5996 | `console.log(... Request body:, JSON.stringify(req.body, null, 2))` | Raw body logged (appointment, form, RAG webhooks). |
| `server/routes/webhook-routes.ts` | 6096 | `console.log(... Request body:, JSON.stringify(req.body))` | Raw body logged (PlayAudio webhook). |
| `server/engines/plivo/routes/plivo-webhooks.ts` | 523 | `logger.info(... Raw Body: ${JSON.stringify(req.body)})` | Raw body logged. |
| `server/engines/plivo/routes/plivo-webhooks.ts` | 603 | `logger.info(... Body: ${JSON.stringify(req.body)})` | Raw body logged. |
| `server/engines/plivo/routes/plivo-webhooks.ts` | 713 | `logger.info(... Full body: ${JSON.stringify(req.body)})` | Raw body logged. |
| `server/routes/webhook-routes.ts.backup` | 18, 67 | `console.log(... Body:, req.body)` | Same pattern in a backup file. Not loaded, but still in the tree. |

No hit in the HIGH class is routed through `server/services/audit-log.ts` redaction. These are console and logger calls, not audit writes.

## MEDIUM

| File | Line(s) | Logged expression | Why |
|---|---|---|---|
| `server/services/elevenlabs.ts` | 1093, 1354, 3691 | `JSON.stringify(requestBody)` before outbound API call | Whole request payload, may include credentials or config. |
| `server/services/elevenlabs.ts` | 3567 | `JSON.stringify(body)` update payload | Whole payload logged. |
| `server/services/outbound-call-service.ts` | 133, 152 | Full request payload; full response body text | Whole payload and response logged. |
| `server/services/google-calendar/google-calendar.service.ts` | 55 | `await resp.text()` on token refresh failure | OAuth response text logged. |
| `server/services/google-calendar/google-calendar.routes.ts` | 156 | `errText` on token exchange failure | OAuth response text logged. |
| `server/services/google-sheets/google-sheets.routes.ts` | 170 | `errText` on token exchange failure | OAuth response text logged. |
| `server/services/google-sheets/google-sheets.service.ts` | 76 | `await resp.text()` on token refresh failure | OAuth response text logged. |
| `server/services/google-sheets/google-sheets.service.js` | 50 | `await resp.text()` (mirror) | Same as above. |
| `server/services/google-calendar/google-calendar.service.js` | 31 | `await resp.text()` (mirror) | Same as above. |
| `server/engines/payment/gateways/stripe/routes.ts` | 67, 157, 245, 257, 370, 434, 513, 551, 583, 606, 633, 636, 676 | `logger.error(..., error, 'Stripe')` | Whole error object logged. May include request config. |
| `server/routes/auth-routes.ts` | 206, 261, 312, 620, 683, 850 | `logger.error(..., error, 'Auth')` | Whole error object logged. |
| `server/modules/widget/public-widget-routes.ts` | 1177 | `console.error('Error getting ephemeral token:', error)` | Whole error object logged. |

## LOW (summary)

187 hits log a name, id, count, status, or a message. Examples:
- Redaction-aware webhook URL logs in `server/services/*-elevenlabs-tool.ts` use `.replace(secret, '[TOKEN]')`. Logging the URL is safe because the secret is masked.
- Stripe handler logs in `server/routes/stripe-routes.ts` log ids, plan names, and error messages.
- `server/routes/webhook-routes.ts` lines 1150, 1868, 1887, and 5982, 5994 log CallSid, body keys, or token presence only.
- `server/services/elevenlabs.ts` 336 and 3032 log a warning about a missing key, or the model id.
- Persisted webhook-secret messages in `server/services/*-elevenlabs-tool.ts` log events, not values.

## Audit-log redaction check

File: `server/services/audit-log.ts`
- `redactFreeText` (line 98) applies `redactString` to `resourceType`, `resourceId`, and `userAgent`.
- `redactArguments` (imported from `server/services/redaction.ts`, defined at line 181) applies to `metadata` (line 110).
- Console output in `logAuditEvent` (lines 118–128) prints redacted `metadata` only. `userId`, `ipAddress`, and `targetUserId` are not redacted, which is expected for audit context.
- None of the HIGH hits pass through these functions. The audit-log redaction does not cover the console and logger calls found by this scan.

## Literal secrets

A pattern scan for common literal formats (`sk_live_`, `sk_test_`, `whsec_`, `AKIA`, `xox[bp]-`, JWT prefix) found no literal secret in `server/`. Nothing is marked "literal present".

## Not verified

- `server/utils/logger.ts` (exported `logger`) was not inspected for a built-in redaction step. If it redacts, some HIGH and MEDIUM items may be lower risk. This needs a follow-up read.
- Whether the `req.body` logs are gated by a debug flag was not checked.

## Next steps (not performed)

Fixes were out of scope. Suggested order: remove the OTP log at `auth-routes.ts:198`, remove full token output at `webhook-routes.ts:5986-5987`, drop the `client_secrets` dump at `public-widget-routes.ts:1162`, then replace raw `req.body` logs with a redacted summary.
