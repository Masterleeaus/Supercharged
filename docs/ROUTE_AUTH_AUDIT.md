# Route Auth Audit (issue #126)

Status: complete pass, 2026-11-10. Replaces the draft "step 1" audit. Read-only except for the fixes listed in section 4.

Scope: every route registered in `server/` that is reachable from `server/index.ts` and `server/routes.ts` (through `server/routes/core/*.ts`), plus WebSocket upgrade handlers. Files that are not imported by anything (listed in section 5) are recorded as not applicable.

## 1. Result

- Route registrations checked: 799 (HTTP routes, plus identifier-path routes in the workforce factories). Table in section 8.
- Checked (auth present, own verification, or mount-level auth): 707
- Not applicable (public by design, not mounted, or bootstrap): 87
- Open (gap, not fixed): 5 (4 Plivo-ElevenLabs HTTP routes, 1 public settings route), all in section 3
- WebSocket upgrade paths: 4 rows in section 2, all open
- Fixed in #126: 1 (RAG tool-webhook bearer compare is now constant-time)

Counts come from an AST pass over `server/` (TypeScript compiler from `node_modules`) followed by mount and public-by-design rules. The generator scripts are not committed. Each row in section 8 has the route, method, auth middleware, permission check, status and reason.

## 2. Corrections to the draft

The draft (before #126) was out of date. These items were stale or wrong:

- **HIGH play-audio (POST /api/elevenlabs/tools/play-audio/:agentId): stale.** The route now is `/api/elevenlabs/tools/play-audio/:token/:agentId`. The handler checks the URL token with `validateAppointmentWebhookToken` before any work, and it checks that `audioUrl` is https on this app's own host (`server/routes/core/provider-webhook-routes.ts:53`). `tests/security/play-audio-secret.test.mjs` covers it. Not a gap.
- **Plivo GET `/api/plivo/voice/transfer` and GET `/api/plivo/incoming` "unsigned": wrong.** Both carry `verifyPlivo` (`server/engines/plivo/routes/plivo-webhooks.ts:675, 702, 720`).
- **Line references moved.** `server/routes.ts` is now 218 lines and only calls `registerXRoutes()` functions in `server/routes/core/`. The inline routes, the `/api` hybrid gate (now `stream-widget-routes.ts:47`) and the stream upgrade proxies (now WebSocket handlers, section 2) are in those files.
- **Plivo-ElevenLabs webhooks: the draft said "not read". Read now. Live and unsigned. See section 3, item 1.**

## 3. Open gaps (not fixed in #126)

1. **HIGH: Plivo-ElevenLabs HTTP webhooks have no signature check.** `POST /api/plivo-elevenlabs/voice/answer`, `/voice/:callId`, `/voice/status` and `/incoming` (`server/engines/plivo-elevenlabs/routes/webhooks.ts`) are mounted by `initPlivoElevenLabsEngine` (`server/routes/core/voice-engine-routes.ts:39`). `/voice/status` marks calls complete and deducts credits (`deductCallCredits`), so anyone who can reach the app can trigger it. The fix is to apply `requirePlivoV2Signature(getWebhookBaseUrl())` (`server/engines/plivo/plivo-signature.ts`) to these four routes. It is not made because that verifier only reads the `plivo_credentials` table, while ElevenLabs trunk calls use each trunk's own credentials (`sipTrunks.username` / `sipTrunks.password`, `server/infrastructure/bullmq/call-worker.ts:157`). A fix that checks only `plivo_credentials` would reject real calls. The fix must also accept the trunk tokens. That change cannot be tested here without a live Plivo account, so it is left open for the owner.
2. **MEDIUM: WebSocket stream upgrades accept any client.** See section 2. Any client that knows a call ID can attach to the audio stream. Fixing this needs a per-call token that Plivo and Twilio can carry in the stream URL. That changes the provider contract, so it is open.
3. **LOW: widget session token compare is not constant-time.** `server/modules/widget/public-widget-routes.ts` compares `session.sessionToken !== sessionToken` at six call sites (lines 624, 663, 875, 905, 1196, 1406). Same fix pattern as the RAG change, but six call sites in a large file, so it is left for a separate change.
4. **DECISION: `GET /api/settings/llm-margin` is public.** It returns the LLM margin percentage. `client/src/pages/Agents.tsx:276` calls it. Keep it public or require auth is the owner's call, because the client may need it before login.
5. **Not re-read in this pass: payment `/config` payloads.** The six `GET /config` routes are public by design. Their response bodies were not re-read to confirm that only publishable keys are returned.

## 4. Fixes made in #126

- **RAG tool webhook, `POST /api/rag-knowledge/tool-webhook`** (`server/routes/rag-knowledge-routes.ts`). Bearer token compare changed from `!==` to `timingSafeEqual` after a length check. Accept and reject behaviour is the same, 503 when `WEBHOOK_TOKEN` is unset is unchanged. Regression test: `tests/security/rag-tool-webhook-token.test.mjs`.

Checks run after the change: `node --test --experimental-transform-types tests/routes/*.test.mjs tests/security/*.test.mjs tests/middleware/*.test.mjs` gives 548 pass, 0 fail. Narrow typecheck of `server/routes/rag-knowledge-routes.ts` (tsconfig limited to that file, skipLibCheck) reports no errors in that file. The 349 errors it prints come from the wider import graph and are not in the changed file.

Changes that were considered and not made: the Plivo-ElevenLabs signature (section 3, item 1), public settings and payment config (items 4 and 5).

## 5. Not mounted (no import reaches them)

These files define routes, but nothing imports them, so no request reaches them. They are recorded as not applicable. Deleting them is a separate cleanup.

- `server/routes/stripe-routes.ts`, `razorpay-routes.ts`, `paystack-routes.ts`, `paypal-routes.ts`, `mercadopago-routes.ts` (the live payment routes are in `server/engines/payment/gateways/*/routes.ts`, mounted by `server/routes/core/payment-routes.ts`)
- `server/routes/metrics-routes.ts` (`/metrics`)
- `server/modules/comms/email-inbound-route.ts`, `server/modules/comms/telegram-webhook-route.ts`

## 6. Mounts (router-level and mount-level auth)

| Mount | Router | Mount-level auth | Per-route auth | Status |
|---|---|---|---|---|
| (root) | `routes/core/public-auth-routes.ts`: public-routes, auth-routes | none | see section 6 | Public routes listed in section 6 |
| (root) | `routes/core/platform-routes.ts`: agent, campaign, phone, analytics, notification, user-address, user-webhook, user-sip-gateways, template, subscription | none | yes, every route | checked |
| (root) | `engines/plivo` (`setupPlivoWebhooks`, `createPlivoApiRoutes`) | `requireAuth` on `/api/plivo/openai`, `/phone-numbers`, `/incoming-connections`; `verifyPlivo` on every webhook | yes | checked |
| (root) | `engines/plivo-elevenlabs` | none | none | **open** (section 3, item 1) |
| `/api/twilio-openai` | `engines/twilio-openai/routes/twilio-openai-webhooks.ts` | `validateTwilioWebhook` on `/voice/*` | n/a | checked |
| `/api/twilio-openai/incoming-connections` | `engines/twilio-openai/routes/twilio-openai-incoming-connections.ts` | `requireAuth` | yes | checked |
| (root) | `engines/kyc` | none | yes, `requireAuth` / `requireAdmin` | checked |
| `/api/admin/plugins/installer`, `/api/admin/plugins` | `routes/plugin-installer.ts`, `routes/plugin-routes.ts` default router | `checkAdminOrTeamMember` (+ `requireAdminPermission`) | n/a | checked |
| `/api/plugins` | `routes/plugin-routes.ts` `userPluginRouter` | `authenticateAnyToken` | n/a | checked |
| `/api/plugins` | `routes/plugin-routes.ts` `publicPluginRouter` | none (health, docs, bundle) | n/a | not applicable (public) |
| `/api/stripe`, `/api/razorpay`, `/api/paypal`, `/api/paystack`, `/api/mercadopago`, `/api/yookassa` | `engines/payment/gateways/*/routes.ts` | per route (`authenticateToken`), webhooks verified in handler | yes | checked |
| `/api/admin` | `routes/admin-routes.ts` | `router.use(checkAdminOrTeamMember)` (line 49) | n/a | checked |
| `/api/admin` | `routes/admin-team-access.routes.ts` | per route | yes | checked |
| `/api/admin/llm-models` | `routes/llm-models-routes.ts` | `checkAdminOrTeamMember` | n/a | checked |
| `/api/admin/platform-languages` | `routes/platform-languages-routes.ts` | `checkSuperAdmin` (line 50) | n/a | checked |
| `/api/admin/email-settings` | `routes/email-settings-routes.ts` | `checkAdminOrTeamMember` | n/a | checked |
| `/api/admin/transactions`, `/api/transactions`, `/api/admin/refunds` | `routes/transactions-routes.ts`, `refund-routes.ts` | per route | yes | checked |
| `/api/audio`, `/api/invoices`, `/api/incoming-connections` | `routes/audio-routes.ts`, `invoice-routes.ts`, `incoming-connections-routes.ts` | per route `authenticateHybrid` | yes | checked |
| `/api/flow-automation` | `routes/flow-automation/*.ts` | `authenticateHybrid` on mount (`routes/core/user-service-routes.ts:19`) | n/a | checked |
| `/api/crm` | `routes/crm-routes.ts` | `authenticateHybrid` on mount (`routes/core/crm-public-routes.ts:12`) | `requireAuth` per route | checked |
| `/api/public/platform-languages` | `routes/platform-languages-routes.ts` (public router) | none | n/a | not applicable (public) |
| `/api/public` | `modules/widget/public-widget-routes.ts` | none; widget token in path or session token in body; `apiRateLimiter` | n/a | not applicable (public) for config and start; session routes checked |
| `/api` (widget) | `modules/widget/widget-routes.ts` | `hybridGateUnlessExempt(authenticateHybrid)` (`routes/core/stream-widget-routes.ts:47`) | `requireAuth` per route | checked |
| `/api/rag-knowledge` | `routes/rag-knowledge-routes.ts` | per route `authenticateHybrid`; `/tool-webhook` checks its own bearer token | yes | checked |
| `/api/integrations/google` | `services/google-sheets/google-sheets.routes.ts` | `authenticateToken` on mount (`routes/core/integration-routes.ts:18`) | n/a | checked |
| `/api/google-calendar` | `services/google-calendar/google-calendar.routes.ts` | `authenticateToken` on mount (`routes/core/integration-routes.ts:22`) | n/a | checked |
| `/api/chatbot` | `modules/chatbot/chatbot-routes.ts` | `authenticateHybrid` + `requireCompanyScope` (`registerChatbotModule`) | role guards per route | checked |
| `/api/chatbot/builder`, `/agent`, `/bookings`, `/content` | `modules/chatbot/*` | `authenticate` + `requireCompanyScope` on mount (`wiring/mount.ts:250, 266, 281, 295`) | role guards / staff identity | checked |
| `/api/public/chatbot/widget` | `modules/chatbot/wiring/mount.ts` | none; widget embed (`publicId`) | n/a | not applicable (public) |
| `/api/chatbot/channels/:companyId/*` | Telegram, WhatsApp, Messenger, Instagram routers | provider `verifyWebhook` in `channels/framework.ts` (secret token, Twilio or X-Hub signature, verify token) | n/a | checked |
| `/api/approvals` | `modules/approvals/approval-routes.ts` | `authenticate` + `requireCompanyScope()` (`modules/approvals/index.ts:119`) | role guards per route | checked |
| `/api/comms` | `modules/campaigns/campaigns-router.ts` | `authenticateToken` + `requireCompanyScope` (`routes/core/workforce-comms-routes.ts:98`) | `staffOnly` per route | checked |
| `/api/comms/inbox`, `/api/comms/marketing` | `modules/inbox`, `modules/marketing` | `deskMode`, `authenticate`, `requireCompanyScope`, actor check (`routes/core/optional-comms-routes.ts:34-36`); only when `COMMS_*_ENABLED=true` | `staffOnly` per route | checked (flag off by default) |
| `/api/workforce/*`, `/api/desk-mode`, `/api/campaigns/responses`, `/api/webhooks/dead-letters` | `routes/workforce-roster-routes.ts`, `routes/cockpit-routes.ts`, `routes/dead-letter-routes.ts`, `workforce/runtime/*` | `authenticate` injected per factory (`guards.authenticate`) | yes: `requireAdmin` / `requireManager` / `requireApprover` / `requireAdminOrManager` plus `requireCompanyScope` | checked; tests in `tests/security/route-permissions.test.mjs` and `tests/security/workforce-route-auth.test.mjs` |
| `/api/titan-bridge/v1/*` | `integrations/titan-field/route.ts`, `local-link-route.ts` | HMAC signature with timestamp (`protocol.mjs`); 503 unless enabled | n/a | checked |
| `/api/webhooks/twilio/*` | `routes/core/provider-webhook-routes.ts` | `validateTwilioWebhook` + rate limit | n/a | checked |
| `/api/webhooks/elevenlabs` | same file | ElevenLabs signature in handler, fails closed | n/a | checked |
| `/api/webhooks/elevenlabs/rag-tool`, `/appointment`, `/form`, `/api/elevenlabs/tools/play-audio` | same file | URL token in handler | n/a | checked |
| `/api/auth/*` | `routes/auth-routes.ts` | none on login, register, OTP and reset (`authRateLimiter`); refresh and logout check the refresh cookie | n/a | checked or not applicable |
| `/api/installer/*`, `/api/init`, `/api/health`, `/api/settings/*`, `/api/branding`, `/api/contact`, `/api/twilio-countries`, `/sitemap.xml`, `/robots.txt` | `routes/public-routes.ts` | none, public by design | n/a | not applicable (public); `/api/settings/llm-margin` open (section 3, item 4) |
| `/api/plans`, `/api/credit-packages` | `routes/subscription-routes.ts` | none, public catalog | n/a | not applicable (public) |
| `/api/demo-mode/status` | `demo-mode/index.ts` | none; optional JWT returns a boolean only | n/a | not applicable (public) |
| `/api/diagnostic/grant-admin` | `routes/public-routes.ts` | always 410 | n/a | not applicable |
| global | `routes.ts` `maintenanceMiddleware`, team context on `/api` (when plugin installed), `hybridGateUnlessExempt` on `/api` (from `stream-widget-routes.ts` onward) | not authentication; gate applies to routes registered after it | n/a | info |

## 7. WebSocket upgrade paths

These are not HTTP routes, so they are not in the table in section 8. Each one is handled in an `httpServer.on('upgrade')` handler. None checks a credential on the upgrade request.

| Path | Handler | Auth on upgrade | Status | Reason |
|---|---|---|---|---|
| `/api/webhooks/twilio/stream` | `server/routes/core/twilio-stream-upgrade.ts` | none; routes by `customParameters.callId` and `agentId` from the Twilio `start` event | open | Section 3, item 2 |
| `/api/twilio-openai/stream/:callSid` | `server/engines/twilio-openai/routes/twilio-openai-stream.ts` | none | open | Section 3, item 2 |
| `/api/plivo/stream/:callUuid` | `server/engines/plivo/routes/plivo-stream.ts` | none | open | Section 3, item 2 |
| `/api/plivo-elevenlabs/stream/:callUuid` | `server/engines/plivo-elevenlabs/routes/stream.ts` | none | open | Section 3, item 2 |

## 8. Per-route table

Columns: line in the file, method, route, auth middleware (as in the code), permission check (role guard or in-handler role check), status, reason. "Per-route auth" means the auth middleware is on the route line. "mount:" means the auth comes from the mount in section 6.

### `server/demo-mode/index.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 327 | GET | `/api/demo-mode/status` | none; JWT optional (returns a boolean only) | none | not applicable | Public by design. |

### `server/engines/kyc/routes/kyc-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 71 | GET | `/api/kyc/status` | requireAuth | none | checked | Per-route auth. |
| 85 | GET | `/api/kyc/documents` | requireAuth | none | checked | Per-route auth. |
| 99 | POST | `/api/kyc/upload` | requireAuth | none | checked | Per-route auth. |
| 139 | DELETE | `/api/kyc/documents/:id` | requireAuth | none | checked | Per-route auth. |
| 154 | POST | `/api/kyc/submit` | requireAuth | none | checked | Per-route auth. |
| 168 | GET | `/api/kyc/check-purchase/:provider` | requireAuth | none | checked | Per-route auth. |
| 205 | GET | `/api/admin/users/:userId/kyc` | requireAdmin | none | checked | Per-route auth. |
| 220 | GET | `/api/admin/users/:userId/kyc/documents` | requireAdmin | none | checked | Per-route auth. |
| 235 | POST | `/api/admin/users/:userId/kyc/approve` | requireAdmin | none | checked | Per-route auth. |
| 250 | POST | `/api/admin/users/:userId/kyc/reject` | requireAdmin | none | checked | Per-route auth. |
| 266 | GET | `/api/kyc/document/:userId/:filename` | requireAdmin | none | checked | Per-route auth. |
| 298 | GET | `/api/admin/kyc/documents/:documentId/download` | requireAdmin | none | checked | Per-route auth. |

### `server/engines/payment/gateways/mercadopago/routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 44 | GET | `/config` | none | none | not applicable | Public by design (checkout config). Payload not re-read in this pass. |
| 58 | POST | `/create-preference` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 143 | POST | `/verify-payment` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 232 | POST | `/create-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 286 | POST | `/confirm-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 405 | POST | `/cancel-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 465 | POST | `/webhook` | provider signature or API re-fetch in handler (stripe-signature, x-razorpay-signature, PayPal verify, x-signature, x-paystack-signature, YooKassa API re-fetch) | none | checked | Own verification. |

### `server/engines/payment/gateways/paypal/routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 61 | GET | `/config` | none | none | not applicable | Public by design (checkout config). Payload not re-read in this pass. |
| 79 | POST | `/create-order` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 167 | POST | `/capture-order` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 218 | POST | `/verify-order` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 321 | POST | `/create-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 388 | POST | `/confirm-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 507 | POST | `/cancel-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 567 | POST | `/webhook` | provider signature or API re-fetch in handler (stripe-signature, x-razorpay-signature, PayPal verify, x-signature, x-paystack-signature, YooKassa API re-fetch) | none | checked | Own verification. |

### `server/engines/payment/gateways/paystack/routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 54 | GET | `/config` | none | none | not applicable | Public by design (checkout config). Payload not re-read in this pass. |
| 72 | POST | `/initialize-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 153 | POST | `/verify-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 285 | POST | `/initialize-credits` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 371 | POST | `/verify-credits` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 457 | POST | `/verify-transaction` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 520 | POST | `/cancel-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 580 | POST | `/refund` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 603 | POST | `/webhook` | provider signature or API re-fetch in handler (stripe-signature, x-razorpay-signature, PayPal verify, x-signature, x-paystack-signature, YooKassa API re-fetch) | none | checked | Own verification. |
| 705 | POST | `/verify-payment` | authenticateToken (inline) | owner from session | checked | Per-route auth. |

### `server/engines/payment/gateways/razorpay/routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 52 | GET | `/config` | none | none | not applicable | Public by design (checkout config). Payload not re-read in this pass. |
| 66 | POST | `/create-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 138 | POST | `/verify-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 271 | POST | `/create-order` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 351 | POST | `/verify-order` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 433 | POST | `/verify-payment` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 503 | POST | `/cancel-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 541 | POST | `/refund` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 564 | POST | `/webhook` | provider signature or API re-fetch in handler (stripe-signature, x-razorpay-signature, PayPal verify, x-signature, x-paystack-signature, YooKassa API re-fetch) | none | checked | Own verification. |

### `server/engines/payment/gateways/stripe/routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 58 | GET | `/config` | none | none | not applicable | Public by design (checkout config). Payload not re-read in this pass. |
| 72 | POST | `/create-payment-intent` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 162 | POST | `/confirm-payment` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 262 | POST | `/create-checkout-session` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 375 | POST | `/verify-session` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 439 | POST | `/change-plan` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 518 | POST | `/reactivate-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 556 | POST | `/cancel-subscription` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 588 | POST | `/refund` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 611 | POST | `/webhook` | provider signature or API re-fetch in handler (stripe-signature, x-razorpay-signature, PayPal verify, x-signature, x-paystack-signature, YooKassa API re-fetch) | none | checked | Own verification. |

### `server/engines/payment/gateways/yookassa/routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 31 | GET | `/config` | none | none | not applicable | Public by design (checkout config). Payload not re-read in this pass. |
| 45 | POST | `/create-checkout-session` | authenticateToken (inline) | owner from session | checked | Per-route auth. |
| 140 | POST | `/webhook` | provider signature or API re-fetch in handler (stripe-signature, x-razorpay-signature, PayPal verify, x-signature, x-paystack-signature, YooKassa API re-fetch) | none | checked | Own verification. |

### `server/engines/plivo-elevenlabs/routes/webhooks.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 27 | POST | `/api/plivo-elevenlabs/voice/answer` | none | none | open | HIGH. Plivo-ElevenLabs webhook is live (initPlivoElevenLabsEngine) and not signed. It deducts call credits. Fix needs the per-trunk token source (sipTrunks.password). Not changed in #126. |
| 54 | POST | `/api/plivo-elevenlabs/voice/:callId` | none | none | open | HIGH. Plivo-ElevenLabs webhook is live (initPlivoElevenLabsEngine) and not signed. It deducts call credits. Fix needs the per-trunk token source (sipTrunks.password). Not changed in #126. |
| 104 | POST | `/api/plivo-elevenlabs/voice/status` | none | none | open | HIGH. Plivo-ElevenLabs webhook is live (initPlivoElevenLabsEngine) and not signed. It deducts call credits. Fix needs the per-trunk token source (sipTrunks.password). Not changed in #126. |
| 269 | POST | `/api/plivo-elevenlabs/incoming` | none | none | open | HIGH. Plivo-ElevenLabs webhook is live (initPlivoElevenLabsEngine) and not signed. It deducts call credits. Fix needs the per-trunk token source (sipTrunks.password). Not changed in #126. |

### `server/engines/plivo/routes/plivo-api.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 65 | GET | `/api/plivo/openai/voices` | requireAuth | none | checked | Per-route auth. |
| 81 | GET | `/api/plivo/openai/models` | requireAuth | none | checked | Per-route auth. |
| 115 | GET | `/api/plivo/openai/models/:tier` | requireAuth | none | checked | Per-route auth. |
| 145 | GET | `/api/plivo/admin/openai/pool/stats` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 're | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 159 | GET | `/api/plivo/admin/openai/credentials` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 're | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 173 | POST | `/api/plivo/admin/openai/credentials` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'cr | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 204 | PATCH | `/api/plivo/admin/openai/credentials/:id` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 229 | DELETE | `/api/plivo/admin/openai/credentials/:id` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'de | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 244 | POST | `/api/plivo/admin/openai/credentials/:id/activate` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 259 | POST | `/api/plivo/admin/openai/credentials/:id/deactivate` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 274 | POST | `/api/plivo/admin/openai/pool/health-check` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 289 | POST | `/api/plivo/admin/openai/pool/recalculate` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 307 | GET | `/api/plivo/admin/credentials` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 're | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 334 | POST | `/api/plivo/admin/credentials` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'cr | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 373 | PATCH | `/api/plivo/admin/credentials/:id` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 409 | DELETE | `/api/plivo/admin/credentials/:id` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'de | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 428 | GET | `/api/plivo/admin/phone-pricing` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 're | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 446 | POST | `/api/plivo/admin/phone-pricing` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'cr | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 477 | PATCH | `/api/plivo/admin/phone-pricing/:id` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 505 | DELETE | `/api/plivo/admin/phone-pricing/:id` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'de | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 525 | POST | `/api/plivo/admin/sync-numbers` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 549 | GET | `/api/plivo/admin/phone-numbers` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 're | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 564 | PATCH | `/api/plivo/admin/phone-numbers/:id/assign` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 587 | GET | `/api/plivo/phone-numbers` | requireAuth | none | checked | Per-route auth. |
| 603 | GET | `/api/plivo/phone-numbers/search` | requireAuth | none | checked | Per-route auth. |
| 637 | GET | `/api/plivo/phone-numbers/pricing/:countryCode` | requireAuth | none | checked | Per-route auth. |
| 658 | GET | `/api/plivo/phone-numbers/countries` | requireAuth | none | checked | Per-route auth. |
| 677 | POST | `/api/plivo/phone-numbers/purchase` | requireAuth | none | checked | Per-route auth. |
| 729 | DELETE | `/api/plivo/phone-numbers/:id` | requireAuth | none | checked | Per-route auth. |
| 761 | GET | `/api/plivo/admin/phone-numbers/account` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 're | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 776 | POST | `/api/plivo/admin/phone-numbers/sync` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'up | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 795 | GET | `/api/plivo/admin/phone-numbers/stats` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 're | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 810 | DELETE | `/api/plivo/admin/phone-numbers/:id/unrent` | requireAdminAuth, requireAdminPermission('integrations', 'plivo_settings', 'de | requireAdminPermission('integrations', ' | checked | Per-route auth. |
| 830 | GET | `/api/plivo/incoming-connections` | requireAuth | none | checked | Per-route auth. |
| 969 | POST | `/api/plivo/incoming-connections` | requireAuth | none | checked | Per-route auth. |
| 1059 | DELETE | `/api/plivo/incoming-connections/:phoneNumberId` | requireAuth | none | checked | Per-route auth. |

### `server/engines/plivo/routes/plivo-webhooks.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 271 | POST | `/api/plivo/voice/answer` | verifyPlivo | none | checked | Per-route auth. |
| 302 | POST | `/api/plivo/voice/:callId` | verifyPlivo | none | checked | Per-route auth. |
| 337 | POST | `/api/plivo/voice/status` | verifyPlivo | none | checked | Per-route auth. |
| 421 | POST | `/api/plivo/status/:callId` | verifyPlivo | none | checked | Per-route auth. |
| 508 | POST | `/api/plivo/voice/recording` | verifyPlivo | none | checked | Per-route auth. |
| 537 | POST | `/api/plivo/recording/:callId` | verifyPlivo | none | checked | Per-route auth. |
| 562 | POST | `/api/plivo/recording/callback/:callRecordId` | verifyPlivo | none | checked | Per-route auth. |
| 675 | GET | `/api/plivo/voice/transfer` | verifyPlivo | none | checked | Per-route auth. |
| 676 | POST | `/api/plivo/voice/transfer` | verifyPlivo | none | checked | Per-route auth. |
| 681 | POST | `/api/plivo/voice/hangup` | verifyPlivo | none | checked | Per-route auth. |
| 702 | GET | `/api/plivo/incoming` | verifyPlivo | none | checked | Per-route auth. |
| 710 | POST | `/api/plivo/incoming` | verifyPlivo | none | checked | Per-route auth. |
| 720 | GET | `/api/plivo/voice/transfer` | verifyPlivo | none | checked | Per-route auth. |
| 752 | POST | `/api/plivo/voice/post-stream` | verifyPlivo | none | checked | Per-route auth. |
| 814 | POST | `/api/plivo/sms/status` | verifyPlivo | none | checked | Per-route auth. |
| 828 | POST | `/api/plivo/sms/inbound` | verifyPlivo | none | checked | Per-route auth. |

### `server/engines/twilio-openai/routes/twilio-openai-incoming-connections.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 25 | GET | `/` | authenticateToken | none | checked | Per-route auth. |
| 169 | POST | `/` | authenticateToken | none | checked | Per-route auth. |
| 280 | POST | `/:id/resync-webhook` | authenticateToken | none | checked | Per-route auth. |
| 325 | DELETE | `/:id` | authenticateToken | none | checked | Per-route auth. |

### `server/engines/twilio-openai/routes/twilio-openai-webhooks.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 62 | POST | `/voice/incoming` | validateTwilioWebhook on /voice/* (router.use, twilio-openai-webhooks.ts:34) | none | checked | Mount-level signature check. |
| 317 | POST | `/voice/answer` | validateTwilioWebhook on /voice/* (router.use, twilio-openai-webhooks.ts:34) | none | checked | Mount-level signature check. |
| 389 | POST | `/voice/status` | validateTwilioWebhook on /voice/* (router.use, twilio-openai-webhooks.ts:34) | none | checked | Mount-level signature check. |
| 695 | POST | `/voice/recording` | validateTwilioWebhook on /voice/* (router.use, twilio-openai-webhooks.ts:34) | none | checked | Mount-level signature check. |

### `server/index.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 177 | GET | `/health` | none | none | not applicable | Server bootstrap or static files. Not an API route. |
| 182 | GET | `/health/detailed` | none | none | not applicable | Server bootstrap or static files. Not an API route. |

### `server/integrations/titan-field/local-link-route.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 9 | GET | `/api/titan-bridge/v1/capabilities` | HMAC local-link signature (verifyLocalLinkRequest); 503 unless TITAN_LOCAL_LINK_ENABLED=1 | none | checked | Signed same-host capability endpoint. |

### `server/integrations/titan-field/route.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 84 | POST | `/api/titan-bridge/v1/communication-intents` | HMAC-SHA256 bridge signature + timestamp (receiver.mjs / protocol.mjs), fails closed | none | checked | Signed bridge. 503 unless TITAN_FIELD_BRIDGE_MODE=shadow. |

### `server/modules/approvals/approval-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 118 | GET | `/` | mount: authenticateHybrid + requireCompanyScope() (modules/approvals/index.ts:119) | approverRoles / adminOnly / executorRoles per route; approverRoles | checked | Mount-level auth, then route-level permission. |
| 132 | GET | `/rules` | mount: authenticateHybrid + requireCompanyScope() (modules/approvals/index.ts:119) | approverRoles / adminOnly / executorRoles per route; adminOnly | checked | Mount-level auth, then route-level permission. |
| 136 | POST | `/rules` | mount: authenticateHybrid + requireCompanyScope() (modules/approvals/index.ts:119) | approverRoles / adminOnly / executorRoles per route; adminOnly | checked | Mount-level auth, then route-level permission. |
| 154 | PUT | `/rules/:ruleId` | mount: authenticateHybrid + requireCompanyScope() (modules/approvals/index.ts:119) | approverRoles / adminOnly / executorRoles per route; adminOnly | checked | Mount-level auth, then route-level permission. |
| 173 | DELETE | `/rules/:ruleId` | mount: authenticateHybrid + requireCompanyScope() (modules/approvals/index.ts:119) | approverRoles / adminOnly / executorRoles per route; adminOnly | checked | Mount-level auth, then route-level permission. |
| 187 | GET | `/:id` | mount: authenticateHybrid + requireCompanyScope() (modules/approvals/index.ts:119) | approverRoles / adminOnly / executorRoles per route; approverRoles | checked | Mount-level auth, then route-level permission. |
| 261 | POST | `/:id/revoke` | mount: authenticateHybrid + requireCompanyScope() (modules/approvals/index.ts:119) | approverRoles / adminOnly / executorRoles per route; approverRoles | checked | Mount-level auth, then route-level permission. |
| 288 | POST | `/:id/resubmit` | mount: authenticateHybrid + requireCompanyScope() (modules/approvals/index.ts:119) | approverRoles / adminOnly / executorRoles per route; approverRoles | checked | Mount-level auth, then route-level permission. |
| 326 | POST | `/:id/executed` | mount: authenticateHybrid + requireCompanyScope() (modules/approvals/index.ts:119) | approverRoles / adminOnly / executorRoles per route; executorRoles | checked | Mount-level auth, then route-level permission. |

### `server/modules/campaigns/campaigns-router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 60 | POST | `/audiences` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 73 | GET | `/audiences/:id/resolution` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 79 | POST | `/contacts` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 98 | POST | `/opt-ins` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 111 | POST | `/unsubscribes` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 128 | POST | `/campaigns` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 145 | POST | `/campaigns/:id/steps` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 162 | POST | `/campaigns/:id/activation` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 168 | POST | `/campaigns/:id/steps/:stepId/send-request` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 174 | GET | `/jobs` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 260 | GET | `<path>` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route | checked | Mount-level auth. |
| 261 | POST | `<path>` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route | checked | Mount-level auth. |
| 262 | PATCH | `<path>` | mount: authenticateToken + requireCompanyScope (routes/core/workforce-comms-routes.ts:98) | staffOnly per route | checked | Mount-level auth. |

### `server/modules/chatbot/agent-routes/agent-router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 94 | GET | `/inbox` | mount: authenticateHybrid, then resolveAgentStaffIdentity from req.user (modules/chatbot/wiring/mount.ts:266) | staff identity from req.user; role checked in handlers | checked | Mount-level auth, then route-level permission. |
| 95 | GET | `/conversations/:id` | mount: authenticateHybrid, then resolveAgentStaffIdentity from req.user (modules/chatbot/wiring/mount.ts:266) | staff identity from req.user; role checked in handlers | checked | Mount-level auth, then route-level permission. |
| 96 | POST | `/conversations/:id/messages` | mount: authenticateHybrid, then resolveAgentStaffIdentity from req.user (modules/chatbot/wiring/mount.ts:266) | staff identity from req.user; role checked in handlers | checked | Mount-level auth, then route-level permission. |
| 97 | POST | `/conversations/:id/takeover` | mount: authenticateHybrid, then resolveAgentStaffIdentity from req.user (modules/chatbot/wiring/mount.ts:266) | staff identity from req.user; role checked in handlers | checked | Mount-level auth, then route-level permission. |
| 98 | POST | `/conversations/:id/handback` | mount: authenticateHybrid, then resolveAgentStaffIdentity from req.user (modules/chatbot/wiring/mount.ts:266) | staff identity from req.user; role checked in handlers | checked | Mount-level auth, then route-level permission. |
| 99 | POST | `/conversations/:id/close` | mount: authenticateHybrid, then resolveAgentStaffIdentity from req.user (modules/chatbot/wiring/mount.ts:266) | staff identity from req.user; role checked in handlers | checked | Mount-level auth, then route-level permission. |

### `server/modules/chatbot/booking-routes/router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 141 | GET | `/bookings` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:281) | guard(READ_ROLES / WRITE_ROLES / SETTINGS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 162 | POST | `/bookings` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:281) | guard(READ_ROLES / WRITE_ROLES / SETTINGS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 175 | GET | `/bookings/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:281) | guard(READ_ROLES / WRITE_ROLES / SETTINGS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 189 | PATCH | `/bookings/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:281) | guard(READ_ROLES / WRITE_ROLES / SETTINGS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 209 | POST | `/bookings/:id/cancel` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:281) | guard(READ_ROLES / WRITE_ROLES / SETTINGS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 228 | GET | `/booking-settings` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:281) | guard(READ_ROLES / WRITE_ROLES / SETTINGS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 235 | PATCH | `/booking-settings` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:281) | guard(READ_ROLES / WRITE_ROLES / SETTINGS_ROLES) per route | checked | Mount-level auth, then route-level permission. |

### `server/modules/chatbot/builder-routes/builder-router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 123 | GET | `/builder/avatars` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:250) | guard(READ_ROLES / CONFIG_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 131 | POST | `/builder/avatars` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:250) | guard(READ_ROLES / CONFIG_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 141 | GET | `/builder/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:250) | guard(READ_ROLES / CONFIG_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 152 | PATCH | `/builder/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:250) | guard(READ_ROLES / CONFIG_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 195 | POST | `/builder/:id/uploads` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:250) | guard(READ_ROLES / CONFIG_ROLES) per route | checked | Mount-level auth, then route-level permission. |

### `server/modules/chatbot/channels/instagram/router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 13 | GET | `/webhook/:accountId` | provider verifyWebhook in channel framework (secret token / Twilio signature / X-Hub-Signature-256 / verify token) | none | checked | Own verification. Runs before parse. |
| 17 | POST | `/webhook/:accountId` | provider verifyWebhook in channel framework (secret token / Twilio signature / X-Hub-Signature-256 / verify token) | none | checked | Own verification. Runs before parse. |

### `server/modules/chatbot/channels/messenger/router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 14 | GET | `/webhook/:accountId` | provider verifyWebhook in channel framework (secret token / Twilio signature / X-Hub-Signature-256 / verify token) | none | checked | Own verification. Runs before parse. |
| 18 | POST | `/webhook/:accountId` | provider verifyWebhook in channel framework (secret token / Twilio signature / X-Hub-Signature-256 / verify token) | none | checked | Own verification. Runs before parse. |

### `server/modules/chatbot/channels/telegram/router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 23 | POST | `/webhook/:accountId` | provider verifyWebhook in channel framework (secret token / Twilio signature / X-Hub-Signature-256 / verify token) | none | checked | Own verification. Runs before parse. |

### `server/modules/chatbot/channels/whatsapp/router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 21 | POST | `/webhook` | provider verifyWebhook in channel framework (secret token / Twilio signature / X-Hub-Signature-256 / verify token) | none | checked | Own verification. Runs before parse. |

### `server/modules/chatbot/chatbot-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 138 | GET | `/chatbots` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; readRoles | checked | Mount-level auth, then route-level permission. |
| 146 | POST | `/chatbots` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; configRoles | checked | Mount-level auth, then route-level permission. |
| 159 | GET | `/chatbots/:id` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; readRoles | checked | Mount-level auth, then route-level permission. |
| 172 | PATCH | `/chatbots/:id` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; configRoles | checked | Mount-level auth, then route-level permission. |
| 190 | GET | `/conversations` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; readRoles | checked | Mount-level auth, then route-level permission. |
| 217 | POST | `/conversations` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; conversationRoles | checked | Mount-level auth, then route-level permission. |
| 230 | GET | `/conversations/:id` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; readRoles | checked | Mount-level auth, then route-level permission. |
| 243 | PATCH | `/conversations/:id` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; conversationRoles | checked | Mount-level auth, then route-level permission. |
| 261 | POST | `/conversations/:id/messages` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; conversationRoles | checked | Mount-level auth, then route-level permission. |
| 283 | POST | `/conversations/:id/read` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; conversationRoles | checked | Mount-level auth, then route-level permission. |
| 296 | GET | `/conversations/:id/export` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; readRoles | checked | Mount-level auth, then route-level permission. |
| 317 | GET | `/unread-counts` | mount: authenticateHybrid + requireCompanyScope (routes/core/chatbot-wiring-routes.ts, registerChatbotModule) | readRoles / configRoles / conversationRoles per route; readRoles | checked | Mount-level auth, then route-level permission. |

### `server/modules/chatbot/content-admin/router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 122 | GET | `/content/canned-responses` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 129 | POST | `/content/canned-responses` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 139 | GET | `/content/canned-responses/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 150 | PATCH | `/content/canned-responses/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 163 | DELETE | `/content/canned-responses/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 176 | GET | `/content/knowledge-base-articles` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 183 | POST | `/content/knowledge-base-articles` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 195 | GET | `/content/knowledge-base-articles/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 206 | PATCH | `/content/knowledge-base-articles/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 225 | DELETE | `/content/knowledge-base-articles/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 250 | GET | `/content/contacts` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 258 | GET | `/content/contacts/:id` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |
| 272 | GET | `/content/analytics` | mount: authenticateHybrid + requireCompanyScope (modules/chatbot/wiring/mount.ts:295) | guard(READ_ROLES / CANNED_WRITE_ROLES / ARTICLE_WRITE_ROLES / ANALYTICS_ROLES) per route | checked | Mount-level auth, then route-level permission. |

### `server/modules/chatbot/wiring/mount.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 330 | GET | `/:publicId/config` | none; public widget (publicId) | none | not applicable | Public by design. Widget embed. |
| 331 | POST | `/:publicId/session` | none; public widget (publicId) | none | not applicable | Public by design. Widget embed. |
| 332 | POST | `/:publicId/message` | none; public widget (publicId) | none | not applicable | Public by design. Widget embed. |
| 333 | GET | `/:publicId/check` | none; public widget (publicId) | none | not applicable | Public by design. Widget embed. |
| 334 | GET | `/:publicId/messages` | none; public widget (publicId) | none | not applicable | Public by design. Widget embed. |
| 335 | GET | `/:publicId/stream` | none; public widget (publicId) | none | not applicable | Public by design. Widget embed. |

### `server/modules/comms/email-inbound-route.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 141 | POST | `<path>` | n/a | n/a | not applicable | Not mounted. |

### `server/modules/comms/telegram-webhook-route.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 87 | POST | `<path>` | n/a | n/a | not applicable | Not mounted. |

### `server/modules/desk-modes/express-comms-adapter.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 30 | GET | `<path>` | generic adapter (no route of its own) | inherits from the router it is passed to | checked | Covered by the mount of the router that uses it (see section 6). |
| 31 | POST | `<path>` | generic adapter (no route of its own) | inherits from the router it is passed to | checked | Covered by the mount of the router that uses it (see section 6). |
| 32 | PATCH | `<path>` | generic adapter (no route of its own) | inherits from the router it is passed to | checked | Covered by the mount of the router that uses it (see section 6). |

### `server/modules/inbox/inbox-router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 45 | GET | `/threads` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:34; only when COMMS_INBOX_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 47 | GET | `/threads/:id` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:34; only when COMMS_INBOX_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 49 | GET | `/threads/:id/messages` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:34; only when COMMS_INBOX_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 51 | POST | `/threads/:id/assignment` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:34; only when COMMS_INBOX_ENABLED=true) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 59 | POST | `/threads/:id/status` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:34; only when COMMS_INBOX_ENABLED=true) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 67 | POST | `/threads/:id/drafts` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:34; only when COMMS_INBOX_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 76 | POST | `/threads/:id/messages` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:34; only when COMMS_INBOX_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 85 | POST | `/messages/:id/send-request` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:34; only when COMMS_INBOX_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |

### `server/modules/marketing/marketing-router.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 33 | GET | `/pages` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 45 | GET | `/pages/:id` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 47 | POST | `/pages` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 65 | PATCH | `/pages/:id` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 78 | POST | `/pages/:id/publication` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 84 | POST | `/pages/:id/archive` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 90 | GET | `/content` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 104 | GET | `/content/:id` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 106 | POST | `/content` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 123 | PATCH | `/content/:id` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route | checked | Mount-level auth, then route-level permission. |
| 136 | POST | `/content/:id/approval` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |
| 142 | POST | `/content/:id/publication` | mount: deskMode, authenticate, requireCompanyScope, actor (routes/core/optional-comms-routes.ts:36; only when COMMS_MARKETING_ENABLED=true) | staffOnly per route; staffOnly | checked | Mount-level auth, then route-level permission. |

### `server/modules/widget/public-widget-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 267 | GET | `/widget/config/:token` | none; widget embed token in path/body; apiRateLimiter | none | not applicable | Public by design. Widget embed token. |
| 541 | POST | `/widget/session/start` | none; widget embed token in path/body; apiRateLimiter | none | not applicable | Public by design. Widget embed token. |
| 619 | POST | `/widget/session/:sessionId/connect` | sessionToken in body must equal the stored session token | session token | checked | Own verification. Non-constant-time compare (open, low). |
| 658 | POST | `/widget/session/:sessionId/end` | sessionToken in body must equal the stored session token | session token | checked | Own verification. Non-constant-time compare (open, low). |
| 870 | POST | `/widget/session/:sessionId/heartbeat` | sessionToken in body must equal the stored session token | session token | checked | Own verification. Non-constant-time compare (open, low). |
| 900 | POST | `/widget/session/:sessionId/ephemeral-token` | sessionToken in body must equal the stored session token | session token | checked | Own verification. Non-constant-time compare (open, low). |
| 1191 | POST | `/widget/session/:sessionId/book-appointment` | sessionToken in body must equal the stored session token | session token | checked | Own verification. Non-constant-time compare (open, low). |
| 1401 | POST | `/widget/session/:sessionId/knowledge-lookup` | sessionToken in body must equal the stored session token | session token | checked | Own verification. Non-constant-time compare (open, low). |

### `server/modules/widget/widget-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 70 | GET | `/widgets` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 81 | GET | `/widgets/:id` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 122 | POST | `/widgets` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 194 | PATCH | `/widgets/:id` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 251 | DELETE | `/widgets/:id` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 265 | POST | `/widgets/:id/regenerate-token` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 279 | POST | `/widgets/:id/icon` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 303 | GET | `/widgets/:id/embed-code` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 324 | GET | `/widgets/:id/sessions` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 342 | GET | `/widgets-stats` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 353 | GET | `/widgets-limits` | mount: hybridGateUnlessExempt(authenticateHybrid) on /api (routes/core/stream-widget-routes.ts:47) | requireAuth per route | checked | Mount-level auth, then route-level permission. |

### `server/routes/admin-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 92 | GET | `/analytics` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member | checked | Mount-level auth, then route-level permission. |
| 103 | GET | `/contacts` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member | checked | Mount-level auth, then route-level permission. |

### `server/routes/admin-team-access.routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 20 | GET | `/analytics` | checkAdminOrTeamMember, requireAdminPermission('settings', 'analytics_settings', 're | requireAdminPermission('settings', 'anal | checked | Per-route auth. |

### `server/routes/admin/branding-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 39 | GET | `/branding` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member | checked | Mount-level auth, then route-level permission. |
| 65 | PATCH | `/branding` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('settings', 'edit | checked | Mount-level auth, then route-level permission. |
| 103 | POST | `/branding/upload-logo` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('settings', 'edit | checked | Mount-level auth, then route-level permission. |
| 120 | POST | `/branding/upload-logo-light` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('settings', 'edit | checked | Mount-level auth, then route-level permission. |
| 137 | POST | `/branding/upload-logo-dark` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('settings', 'edit | checked | Mount-level auth, then route-level permission. |
| 154 | POST | `/branding/upload-favicon` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('settings', 'edit | checked | Mount-level auth, then route-level permission. |
| 171 | DELETE | `/branding/logo` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('settings', 'edit | checked | Mount-level auth, then route-level permission. |
| 182 | DELETE | `/branding/logo-light` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('settings', 'edit | checked | Mount-level auth, then route-level permission. |
| 193 | DELETE | `/branding/logo-dark` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('settings', 'edit | checked | Mount-level auth, then route-level permission. |
| 204 | DELETE | `/branding/favicon` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('settings', 'edit | checked | Mount-level auth, then route-level permission. |

### `server/routes/admin/calls-moderation-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 14 | GET | `/calls` | requireAdminPermission('call_monitoring', 'all_calls', 'read | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 57 | GET | `/calls/:id` | requireAdminPermission('call_monitoring', 'all_calls', 'read | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 73 | GET | `/calls/:id/violations` | requireAdminPermission('call_monitoring', 'all_calls', 'read | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 84 | GET | `/calls/:id/recording` | requireAdminPermission('call_monitoring', 'all_calls', 'read | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 104 | GET | `/banned-words` | requireAdminPermission('call_monitoring', 'banned_words', 'r | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 114 | POST | `/banned-words` | requireAdminPermission('call_monitoring', 'banned_words', 'c | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 136 | PATCH | `/banned-words/:id` | requireAdminPermission('call_monitoring', 'banned_words', 'u | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 158 | DELETE | `/banned-words/:id` | requireAdminPermission('call_monitoring', 'banned_words', 'd | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 169 | POST | `/banned-words/scan-all-calls` | requireAdminPermission('call_monitoring', 'banned_words', 'u | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 198 | GET | `/content-violations` | requireAdminPermission('call_monitoring', 'all_calls', 'read | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 218 | PATCH | `/content-violations/:id` | requireAdminPermission('call_monitoring', 'all_calls', 'upda | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 240 | POST | `/calls/:id/scan` | requireAdminPermission('call_monitoring', 'all_calls', 'upda | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 266 | POST | `/elevenlabs-webhooks/verify` | requireAdminPermission('call_monitoring', 'all_calls', 'upda | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 295 | POST | `/calls/:id/fetch-elevenlabs` | requireAdminPermission('call_monitoring', 'all_calls', 'upda | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 341 | POST | `/calls/fetch-all-missing` | requireAdminPermission('call_monitoring', 'all_calls', 'upda | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 406 | POST | `/sync-recordings` | requireAdminPermission('call_monitoring', 'all_calls', 'upda | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 415 | POST | `/sync-all-calls` | requireAdminPermission('call_monitoring', 'all_calls', 'upda | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 425 | POST | `/migrate-call-user-ids` | requireAdminPermission('call_monitoring', 'all_calls', 'upda | requireAdminPermission('call_monitoring' | checked | Per-route auth. |
| 427 | POST | `/sync-incoming-webhooks` | requireAdminPermission('call_monitoring', 'all_calls', 'upda | requireAdminPermission('call_monitoring' | checked | Per-route auth. |

### `server/routes/admin/connections-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 34 | POST | `/test-connection/twilio` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 64 | POST | `/test-connection/elevenlabs` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 122 | POST | `/test-connection/openai` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 150 | POST | `/test-connection/openai-realtime` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 215 | POST | `/test-connection/stripe` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 244 | POST | `/test-connection/paypal` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 280 | POST | `/test-connection/paystack` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 304 | POST | `/test-connection/mercadopago` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 327 | POST | `/test-connection/yookassa` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 354 | POST | `/test-connection/razorpay` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 381 | POST | `/validate-credentials/razorpay` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |

### `server/routes/admin/credit-backfill-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 31 | GET | `/credit-backfill/status` | requireAdminPermission('billing', 'credits', 'read') | requireAdminPermission('billing', 'credi | checked | Per-route auth. |
| 51 | POST | `/credit-backfill/scan` | requireAdminPermission('billing', 'credits', 'read') | requireAdminPermission('billing', 'credi | checked | Per-route auth. |
| 69 | POST | `/credit-backfill/run` | requireAdminPermission('billing', 'credits', 'update') | requireAdminPermission('billing', 'credi | checked | Per-route auth. |

### `server/routes/admin/credit-packages-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 37 | GET | `/credit-packages` | requireAdminPermission('billing', 'credits', 'read') | requireAdminPermission('billing', 'credi | checked | Per-route auth. |
| 47 | POST | `/credit-packages` | requireAdminPermission('billing', 'credits', 'create') | requireAdminPermission('billing', 'credi | checked | Per-route auth. |
| 119 | PATCH | `/credit-packages/:packageId` | requireAdminPermission('billing', 'credits', 'update') | requireAdminPermission('billing', 'credi | checked | Per-route auth. |

### `server/routes/admin/elevenlabs-pool-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 14 | GET | `/elevenlabs-pool` | requireAdminPermission('settings', 'elevenlabs_settings', 'r | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 24 | GET | `/elevenlabs-pool/stats` | requireAdminPermission('settings', 'elevenlabs_settings', 'r | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 34 | POST | `/elevenlabs-pool` | requireAdminPermission('settings', 'elevenlabs_settings', 'c | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 74 | POST | `/elevenlabs-pool/test` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 97 | PATCH | `/elevenlabs-pool/:credentialId/deactivate` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 108 | PATCH | `/elevenlabs-pool/:credentialId/activate` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 121 | DELETE | `/elevenlabs-pool/:credentialId` | requireAdminPermission('settings', 'elevenlabs_settings', 'd | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 152 | POST | `/elevenlabs-pool/health-check` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 162 | POST | `/elevenlabs-pool/sync-agents` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 178 | GET | `/elevenlabs-pool/:credentialId/users` | requireAdminPermission('settings', 'elevenlabs_settings', 'r | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 194 | PATCH | `/elevenlabs-pool/:credentialId/threshold` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 214 | POST | `/elevenlabs-pool/migrate-user` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 243 | GET | `/elevenlabs-pool/retry-queue` | requireAdminPermission('settings', 'elevenlabs_settings', 'r | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 252 | POST | `/elevenlabs-pool/process-retry-queue` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 261 | POST | `/elevenlabs-pool/sync-voice` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 287 | GET | `/elevenlabs-pool/:credentialId/voices` | requireAdminPermission('settings', 'elevenlabs_settings', 'r | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 303 | GET | `/elevenlabs-pool/voice-status/:voiceId` | requireAdminPermission('settings', 'elevenlabs_settings', 'r | requireAdminPermission('settings', 'elev | checked | Per-route auth. |
| 319 | POST | `/elevenlabs-pool/retry-voice-sync` | requireAdminPermission('settings', 'elevenlabs_settings', 'u | requireAdminPermission('settings', 'elev | checked | Per-route auth. |

### `server/routes/admin/phone-numbers-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 15 | GET | `/phone-numbers` | requireAdminPermission('phones', 'phone_numbers', 'read') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 43 | GET | `/phone-numbers/twilio-active` | requireAdminPermission('phones', 'phone_numbers', 'read') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 74 | POST | `/phone-numbers/import` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 145 | DELETE | `/phone-numbers/release/:sid` | requireAdminPermission('phones', 'phone_numbers', 'delete') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 173 | GET | `/phone-numbers/all` | requireAdminPermission('phones', 'phone_numbers', 'read') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 198 | PATCH | `/phone-numbers/:id/assign` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 230 | POST | `/phone-numbers/configure-webhooks` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 282 | GET | `/phone-numbers/migration-status` | requireAdminPermission('phones', 'phone_numbers', 'read') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 308 | POST | `/phone-numbers/migrate/:phoneNumberId` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 328 | POST | `/phone-numbers/migrate-all` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 341 | POST | `/phone-numbers/migrate-agent/:agentId` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 352 | POST | `/phone-numbers/cleanup` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 434 | POST | `/phone-numbers/clear-sync-status` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 447 | POST | `/phone-numbers/sync-to-elevenlabs` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 568 | POST | `/phone-numbers/resync-elevenlabs` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |
| 601 | PATCH | `/phone-numbers/:id/reactivate` | requireAdminPermission('phones', 'phone_numbers', 'update') | requireAdminPermission('phones', 'phone_ | checked | Per-route auth. |

### `server/routes/admin/plans-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 93 | GET | `/plans` | requireAdminPermission('billing', 'plans', 'read') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 103 | POST | `/plans` | requireAdminPermission('billing', 'plans', 'create') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 425 | PATCH | `/plans/:planId` | requireAdminPermission('billing', 'plans', 'update') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 754 | GET | `/plans/:planId/users` | requireAdminPermission('billing', 'plans', 'read') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 780 | POST | `/plans/:planId/migrate` | requireAdminPermission('billing', 'plans', 'update') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 827 | DELETE | `/plans/:planId` | requireAdminPermission('billing', 'plans', 'delete') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 858 | POST | `/plans/:planId/sync/stripe` | requireAdminPermission('billing', 'plans', 'update') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 935 | POST | `/plans/:planId/sync/razorpay` | requireAdminPermission('billing', 'plans', 'update') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 1051 | POST | `/plans/:planId/sync/paypal` | requireAdminPermission('billing', 'plans', 'update') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 1211 | POST | `/plans/:planId/sync/paystack` | requireAdminPermission('billing', 'plans', 'update') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 1272 | POST | `/plans/:planId/sync/mercadopago` | requireAdminPermission('billing', 'plans', 'update') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |
| 1343 | POST | `/plans/:planId/sync/yookassa` | requireAdminPermission('billing', 'plans', 'update') | requireAdminPermission('billing', 'plans | checked | Per-route auth. |

### `server/routes/admin/seo-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 39 | GET | `/seo` | requireAdminPermission('settings', 'seo_settings', 'read') | requireAdminPermission('settings', 'seo_ | checked | Per-route auth. |
| 74 | PATCH | `/seo` | requireAdminPermission('settings', 'seo_settings', 'update') | requireAdminPermission('settings', 'seo_ | checked | Per-route auth. |
| 119 | POST | `/seo/sitemap-urls` | requireAdminPermission('settings', 'seo_settings', 'create') | requireAdminPermission('settings', 'seo_ | checked | Per-route auth. |
| 175 | DELETE | `/seo/sitemap-urls` | requireAdminPermission('settings', 'seo_settings', 'delete') | requireAdminPermission('settings', 'seo_ | checked | Per-route auth. |
| 261 | POST | `/seo/generate-sitemap` | requireAdminPermission('settings', 'seo_settings', 'update') | requireAdminPermission('settings', 'seo_ | checked | Per-route auth. |
| 322 | POST | `/seo/rebuild-sitemap` | requireAdminPermission('settings', 'seo_settings', 'update') | requireAdminPermission('settings', 'seo_ | checked | Per-route auth. |
| 379 | POST | `/seo/upload-image` | requireAdminPermission('settings', 'seo_settings', 'update') | requireAdminPermission('settings', 'seo_ | checked | Per-route auth. |
| 430 | POST | `/seo/upload-image-form` | requireAdminPermission('settings', 'seo_settings', 'update') | requireAdminPermission('settings', 'seo_ | checked | Per-route auth. |
| 450 | GET | `/analytics-scripts` | requireAdminPermission('settings', 'analytics_settings', 're | requireAdminPermission('settings', 'anal | checked | Per-route auth. |
| 460 | POST | `/analytics-scripts` | requireAdminPermission('settings', 'analytics_settings', 'cr | requireAdminPermission('settings', 'anal | checked | Per-route auth. |
| 501 | PATCH | `/analytics-scripts/:id` | requireAdminPermission('settings', 'analytics_settings', 'up | requireAdminPermission('settings', 'anal | checked | Per-route auth. |
| 542 | DELETE | `/analytics-scripts/:id` | requireAdminPermission('settings', 'analytics_settings', 'de | requireAdminPermission('settings', 'anal | checked | Per-route auth. |

### `server/routes/admin/settings-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 31 | GET | `/settings` | requireAdminPermission('settings', 'system_settings', 'read' | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 132 | GET | `/system-settings` | requireAdminPermission('settings', 'system_settings', 'read' | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 172 | GET | `/settings/:key` | requireAdminPermission('settings', 'system_settings', 'read' | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 197 | PATCH | `/settings/:key` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 289 | GET | `/resource-status` | requireAdminPermission('settings', 'system_settings', 'read' | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 299 | GET | `/analytics` | requireAdminPermission('settings', 'analytics_settings', 're | requireAdminPermission('settings', 'anal | checked | Per-route auth. |

### `server/routes/admin/smtp-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 10 | GET | `/smtp` | requireAdminPermission('communications', 'email_settings', ' | requireAdminPermission('communications', | checked | Per-route auth. |
| 34 | PATCH | `/smtp` | requireAdminPermission('communications', 'email_settings', ' | requireAdminPermission('communications', | checked | Per-route auth. |
| 60 | POST | `/smtp/test` | requireAdminPermission('communications', 'email_settings', ' | requireAdminPermission('communications', | checked | Per-route auth. |

### `server/routes/admin/system-update-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 41 | GET | `/system-update/status` | requireAdminPermission('settings', 'system_settings', 'read' | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 60 | GET | `/system-update/history` | requireAdminPermission('settings', 'system_settings', 'read' | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 73 | POST | `/system-update/validate` | requireAdminPermission('settings', 'system_settings', 'creat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 113 | POST | `/system-update/apply` | requireAdminPermission('settings', 'system_settings', 'creat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 168 | POST | `/system-update/reset` | requireAdminPermission('settings', 'system_settings', 'creat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 207 | POST | `/system-update/dismiss` | requireAdminPermission('settings', 'system_settings', 'creat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 219 | POST | `/system-update/rollback/:updateId` | requireAdminPermission('settings', 'system_settings', 'creat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 294 | GET | `/system-update/backups/:updateId/download` | requireAdminPermission('settings', 'system_settings', 'read' | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 341 | DELETE | `/system-update/backups/:updateId` | requireAdminPermission('settings', 'system_settings', 'delet | requireAdminPermission('settings', 'syst | checked | Per-route auth. |

### `server/routes/admin/users-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 12 | GET | `/users/search` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('users', 'view_us | checked | Mount-level auth, then route-level permission. |
| 44 | GET | `/users` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('users', 'view_us | checked | Mount-level auth, then route-level permission. |
| 120 | PATCH | `/users/:userId` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('users', 'edit_us | checked | Mount-level auth, then route-level permission. |
| 232 | POST | `/users` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member | checked | Mount-level auth, then route-level permission. |
| 320 | DELETE | `/users/:userId` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('users', 'delete_ | checked | Mount-level auth, then route-level permission. |
| 394 | POST | `/users/:userId/recover` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('users', 'edit_us | checked | Mount-level auth, then route-level permission. |
| 420 | GET | `/contacts` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('contacts', 'view | checked | Mount-level auth, then route-level permission. |
| 484 | GET | `/users/:userId/webhooks` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('users', 'view_us | checked | Mount-level auth, then route-level permission. |
| 495 | DELETE | `/users/:userId/webhooks/:webhookId` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('users', 'edit_us | checked | Mount-level auth, then route-level permission. |
| 512 | POST | `/users/:id/block` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('users', 'suspend | checked | Mount-level auth, then route-level permission. |
| 534 | POST | `/users/:id/unblock` | mount: checkAdminOrTeamMember, router.use (routes/admin-routes.ts:49) | admin or team member; requireAdminPermission('users', 'suspend | checked | Mount-level auth, then route-level permission. |

### `server/routes/admin/webhooks-setup-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 19 | POST | `/test-webhook/razorpay` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 49 | POST | `/setup-webhook/paypal` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |
| 132 | POST | `/setup-webhook/mercadopago` | requireAdminPermission('settings', 'system_settings', 'updat | requireAdminPermission('settings', 'syst | checked | Per-route auth. |

### `server/routes/agent-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 76 | GET | `/api/agents` | authenticateHybrid | none | checked | Per-route auth. |
| 160 | POST | `/api/agents` | authenticateHybrid | none | checked | Per-route auth. |
| 748 | GET | `/api/agents/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 762 | PATCH | `/api/agents/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 1065 | DELETE | `/api/agents/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 1109 | GET | `/api/knowledge-base` | authenticateHybrid | none | checked | Per-route auth. |
| 1119 | POST | `/api/knowledge-base` | authenticateHybrid | none | checked | Per-route auth. |
| 1158 | POST | `/api/knowledge-base/upload` | authenticateHybrid | none | checked | Per-route auth. |
| 1207 | POST | `/api/knowledge-base/url` | authenticateHybrid | none | checked | Per-route auth. |
| 1247 | POST | `/api/knowledge-base/text` | authenticateHybrid | none | checked | Per-route auth. |
| 1291 | DELETE | `/api/knowledge-base/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 1318 | GET | `/api/agents/:agentId/versions` | authenticateHybrid | none | checked | Per-route auth. |
| 1336 | GET | `/api/agents/:agentId/versions/:versionNumber` | authenticateHybrid | none | checked | Per-route auth. |
| 1363 | POST | `/api/agents/:agentId/versions/:versionNumber/rollback` | authenticateHybrid | none | checked | Per-route auth. |
| 1481 | GET | `/api/voices` | authenticateHybrid | none | checked | Per-route auth. |
| 1491 | POST | `/api/voices/preview` | authenticateHybrid | none | checked | Per-route auth. |
| 1553 | POST | `/api/openai/voices/preview` | authenticateHybrid | none | checked | Per-route auth. |

### `server/routes/analytics-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 43 | GET | `/api/calls` | authenticateHybrid | none | checked | Per-route auth. |
| 80 | GET | `/api/calls/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 115 | GET | `/api/calls/:id/recording` | authenticateHybrid | none | checked | Per-route auth. |
| 339 | POST | `/api/calls/sync-recordings` | authenticateHybrid | none | checked | Per-route auth. |
| 592 | POST | `/api/calls/:callId/fetch-conversation` | authenticateToken | none | checked | Per-route auth. |
| 595 | GET | `/api/dashboard` | authenticateHybrid | none | checked | Per-route auth. |
| 606 | GET | `/api/analytics` | authenticateHybrid | none | checked | Per-route auth. |
| 619 | POST | `/api/analytics/export-pdf` | authenticateHybrid | none | checked | Per-route auth. |

### `server/routes/audio-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 54 | POST | `/upload` | authenticateHybrid as any | none | checked | Per-route auth. |
| 83 | DELETE | `/:filename` | authenticateHybrid as any | none | checked | Per-route auth. |

### `server/routes/auth-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 48 | POST | `/api/auth/send-otp` | none; authRateLimiter | none | not applicable | Public by design (login, register, OTP, password reset). |
| 100 | POST | `/api/auth/verify-otp` | none; authRateLimiter | none | not applicable | Public by design (login, register, OTP, password reset). |
| 159 | POST | `/api/auth/forgot-password/send-otp` | none; authRateLimiter | none | not applicable | Public by design (login, register, OTP, password reset). |
| 211 | POST | `/api/auth/forgot-password/verify-otp` | none; authRateLimiter | none | not applicable | Public by design (login, register, OTP, password reset). |
| 266 | POST | `/api/auth/forgot-password/reset` | none; authRateLimiter | none | not applicable | Public by design (login, register, OTP, password reset). |
| 321 | POST | `/api/auth/register` | none; authRateLimiter | none | not applicable | Public by design (login, register, OTP, password reset). |
| 431 | POST | `/api/admin/users` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 492 | POST | `/api/auth/login` | none; authRateLimiter | none | not applicable | Public by design (login, register, OTP, password reset). |
| 564 | POST | `/api/auth/refresh` | refresh token cookie checked in handler | none | checked | Own verification. |
| 629 | POST | `/api/auth/logout` | refresh token cookie checked in handler | none | checked | Own verification. |
| 656 | POST | `/api/auth/revoke-all-sessions` | authenticateToken | none | checked | Per-route auth. |
| 674 | POST | `/api/admin/auth/cleanup-tokens` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 692 | GET | `/api/auth/me` | authenticateToken | none | checked | Per-route auth. |
| 739 | PATCH | `/api/auth/me` | authenticateToken | none | checked | Per-route auth. |
| 817 | POST | `/api/auth/change-password` | authenticateToken | none | checked | Per-route auth. |
| 859 | GET | `/api/auth/export-data` | authenticateToken | none | checked | Per-route auth. |
| 965 | POST | `/api/auth/delete-account` | authenticateToken | none | checked | Per-route auth. |

### `server/routes/campaign-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 71 | GET | `/api/campaigns` | authenticateHybrid | none | checked | Per-route auth. |
| 110 | GET | `/api/campaigns/deleted` | authenticateHybrid | none | checked | Per-route auth. |
| 121 | PATCH | `/api/campaigns/:id/restore` | authenticateHybrid | none | checked | Per-route auth. |
| 148 | POST | `/api/campaigns` | authenticateHybrid | none | checked | Per-route auth. |
| 357 | GET | `/api/campaigns/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 372 | GET | `/api/campaigns/:id/export` | authenticateHybrid | none | checked | Per-route auth. |
| 443 | PATCH | `/api/campaigns/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 549 | DELETE | `/api/campaigns/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 565 | GET | `/api/campaigns/:campaignId/contacts` | authenticateHybrid | none | checked | Per-route auth. |
| 581 | POST | `/api/campaigns/:campaignId/contacts/upload` | authenticateToken | none | checked | Per-route auth. |
| 645 | GET | `/api/campaigns/:campaignId/calls` | authenticateHybrid | none | checked | Per-route auth. |
| 661 | GET | `/api/campaigns/:campaignId/batch` | authenticateHybrid | none | checked | Per-route auth. |
| 684 | POST | `/api/campaigns/:campaignId/batch/cancel` | authenticateHybrid | none | checked | Per-route auth. |
| 725 | POST | `/api/campaigns/:campaignId/batch/retry` | authenticateHybrid | none | checked | Per-route auth. |
| 775 | GET | `/api/campaigns/:id/validate` | authenticateHybrid | none | checked | Per-route auth. |
| 803 | POST | `/api/campaigns/:id/execute` | authenticateHybrid | none | checked | Per-route auth. |
| 976 | POST | `/api/campaigns/:id/cancel` | authenticateHybrid | none | checked | Per-route auth. |
| 1007 | POST | `/api/campaigns/:id/retry` | authenticateHybrid | none | checked | Per-route auth. |
| 1038 | POST | `/api/campaigns/:id/stop` | authenticateHybrid | none | checked | Per-route auth. |
| 1065 | POST | `/api/campaigns/:id/pause` | authenticateHybrid | none | checked | Per-route auth. |
| 1119 | POST | `/api/campaigns/:id/resume` | authenticateHybrid | none | checked | Per-route auth. |
| 1240 | POST | `/api/campaigns/:id/test-call` | authenticateHybrid | none | checked | Per-route auth. |

### `server/routes/cockpit-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 111 | GET | `/api/workforce/activity` | guards.authenticate, guards.requireCompanyScope, guards.requireApprover | modeFromHost, requireModule('workforce-runtime') as un, guards.requireCompanyScope, guards.requireApprover | checked | Per-route auth. |
| 132 | GET | `/api/desk-mode` | guards.authenticate, guards.requireCompanyScope | modeFromHost, guards.requireCompanyScope | checked | Per-route auth. |
| 142 | GET | `/api/campaigns/responses` | guards.authenticate, guards.requireCompanyScope | modeFromHost, requireModule('campaigns') as unknown as, guards.requireCompanyScope | checked | Per-route auth. |

### `server/routes/core/admin-campaign-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 13 | GET | `/api/admin/campaigns/:id` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 34 | GET | `/api/admin/campaigns/:id/contacts` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 50 | GET | `/api/admin/campaigns/:id/calls` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 65 | GET | `/api/admin/campaigns/:id/batch` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 88 | POST | `/api/admin/migrate-call-user-ids` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |

### `server/routes/core/admin-comms-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 13 | GET | `/api/admin/email-templates` | checkAdminOrTeamMember, requireAdminPermission('communications', 'email_settings', ' | requireAdminPermission('communications', | checked | Per-route auth. |
| 23 | GET | `/api/admin/email-templates/:templateType` | checkAdminOrTeamMember, requireAdminPermission('communications', 'email_settings', ' | requireAdminPermission('communications', | checked | Per-route auth. |
| 36 | PUT | `/api/admin/email-templates/:id` | checkAdminOrTeamMember, requireAdminPermission('communications', 'email_settings', ' | requireAdminPermission('communications', | checked | Per-route auth. |
| 54 | POST | `/api/admin/email-templates` | checkAdminOrTeamMember, requireAdminPermission('communications', 'email_settings', ' | requireAdminPermission('communications', | checked | Per-route auth. |
| 85 | GET | `/api/admin/batch-jobs` | checkAdminOrTeamMember, requireAdminPermission('campaigns', 'batch_jobs', 'read') | requireAdminPermission('campaigns', 'bat | checked | Per-route auth. |
| 153 | GET | `/api/admin/batch-jobs/:batchId` | checkAdminOrTeamMember, requireAdminPermission('campaigns', 'batch_jobs', 'read') | requireAdminPermission('campaigns', 'bat | checked | Per-route auth. |

### `server/routes/core/admin-router-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 39 | GET | `/api/refunds/:id/download` | mount: checkAdminOrTeamMember (routes/admin-routes.ts) | admin or team member | checked | Mount-level auth, then route-level permission. |

### `server/routes/core/admin-user-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 13 | GET | `/api/llm-models/available` | authenticateToken | none | checked | Per-route auth. |
| 45 | POST | `/api/admin/users/:id/credits` | authenticateToken, requireRole("admin", "manager") | requireRole("admin", "manager") | checked | Per-route auth. |
| 78 | GET | `/api/admin/users/:id/limits` | authenticateToken, requireRole("admin", "manager") | requireRole("admin", "manager") | checked | Per-route auth. |
| 128 | PATCH | `/api/admin/users/:id/limits` | authenticateToken, requireRole("admin", "manager") | requireRole("admin", "manager") | checked | Per-route auth. |
| 195 | DELETE | `/api/admin/users/:id/limits` | authenticateToken, requireRole("admin", "manager") | requireRole("admin", "manager") | checked | Per-route auth. |

### `server/routes/core/contacts-tools-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 9 | GET | `/api/contacts` | authenticateToken | none | checked | Per-route auth. |
| 45 | GET | `/api/contacts/deduplicated` | authenticateToken | none | checked | Per-route auth. |
| 55 | DELETE | `/api/contacts/:id` | authenticateToken | none | checked | Per-route auth. |
| 77 | GET | `/api/tools` | authenticateToken | none | checked | Per-route auth. |

### `server/routes/core/elevenlabs-agent-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 17 | GET | `/api/elevenlabs/agents` | authenticateToken | none | checked | Per-route auth. |
| 27 | POST | `/api/elevenlabs/agents` | authenticateToken | none | checked | Per-route auth. |
| 302 | PATCH | `/api/elevenlabs/agents/:id` | authenticateToken | none | checked | Per-route auth. |
| 593 | DELETE | `/api/elevenlabs/agents/:id` | authenticateToken | none | checked | Per-route auth. |
| 630 | POST | `/api/elevenlabs/agents/:id/configure-transfer` | authenticateToken | none | checked | Per-route auth. |

### `server/routes/core/elevenlabs-voice-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 12 | GET | `/api/elevenlabs/voices` | authenticateToken | none | checked | Per-route auth. |
| 35 | GET | `/api/elevenlabs/voice-limit` | authenticateToken | none | checked | Per-route auth. |
| 80 | GET | `/api/elevenlabs/shared-voices` | authenticateToken | none | checked | Per-route auth. |
| 114 | GET | `/api/elevenlabs/llm-pricing` | authenticateToken | none | checked | Per-route auth. |

### `server/routes/core/notification-admin-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 9 | GET | `/api/notifications` | authenticateToken | none | checked | Per-route auth. |
| 20 | GET | `/api/notifications/unread-count` | authenticateToken | none | checked | Per-route auth. |
| 30 | PATCH | `/api/notifications/:id/read` | authenticateToken | none | checked | Per-route auth. |
| 45 | POST | `/api/notifications/read-all` | authenticateToken | none | checked | Per-route auth. |
| 55 | DELETE | `/api/notifications/:id` | authenticateToken | none | checked | Per-route auth. |
| 70 | GET | `/api/notifications/banner` | authenticateToken | none | checked | Per-route auth. |
| 80 | PATCH | `/api/notifications/:id/dismiss` | authenticateToken | none | checked | Per-route auth. |
| 95 | POST | `/api/admin/notifications/broadcast` | authenticateToken | none | checked | Per-route auth. |

### `server/routes/core/prompt-template-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 16 | GET | `/api/prompt-templates` | authenticateToken | none | checked | Per-route auth. |
| 53 | GET | `/api/prompt-templates/:id` | authenticateToken | none | checked | Per-route auth. |
| 77 | POST | `/api/prompt-templates` | authenticateToken | none | checked | Per-route auth. |
| 133 | PATCH | `/api/prompt-templates/:id` | authenticateToken | none | checked | Per-route auth. |
| 190 | DELETE | `/api/prompt-templates/:id` | authenticateToken | none | checked | Per-route auth. |
| 211 | POST | `/api/prompt-templates/:id/use` | authenticateToken | none | checked | Per-route auth. |
| 263 | POST | `/api/admin/prompt-templates/system` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |

### `server/routes/core/provider-webhook-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 28 | POST | `/api/webhooks/twilio/voice` | validateTwilioWebhook | none | checked | Per-route auth. |
| 29 | POST | `/api/webhooks/twilio/incoming` | validateTwilioWebhook | none | checked | Per-route auth. |
| 30 | POST | `/api/webhooks/twilio/status` | validateTwilioWebhook | none | checked | Per-route auth. |
| 31 | POST | `/api/webhooks/twilio/recording` | validateTwilioWebhook | none | checked | Per-route auth. |
| 34 | POST | `/api/webhooks/twilio/flow/answer` | validateTwilioWebhook | none | checked | Per-route auth. |
| 35 | POST | `/api/webhooks/twilio/flow/node` | validateTwilioWebhook | none | checked | Per-route auth. |
| 36 | POST | `/api/webhooks/twilio/flow/gather` | validateTwilioWebhook | none | checked | Per-route auth. |
| 37 | POST | `/api/webhooks/twilio/flow/continue` | validateTwilioWebhook | none | checked | Per-route auth. |
| 38 | POST | `/api/webhooks/twilio/flow/status` | validateTwilioWebhook | none | checked | Per-route auth. |
| 41 | POST | `/api/webhooks/elevenlabs` | ElevenLabs HMAC signature checked in handler (verifyWithAllSecrets, fails closed) | rate limit (IP) | checked | Own verification. |
| 43 | POST | `/api/webhooks/elevenlabs/rag-tool/:token/:agentId` | URL token or x-rag-token header: validateRAGWebhookToken in handler | none | checked | Own verification. Legacy header variant also checked. |
| 44 | POST | `/api/webhooks/elevenlabs/rag-tool/:agentId` | URL token or x-rag-token header: validateRAGWebhookToken in handler | none | checked | Own verification. Legacy header variant also checked. |
| 46 | POST | `/api/webhooks/elevenlabs/appointment/:token/:agentId` | URL token: validateAppointmentWebhookToken / validateFormWebhookToken in handler | none | checked | Own verification. |
| 48 | POST | `/api/webhooks/elevenlabs/form/:token/:formId/:agentId` | URL token: validateAppointmentWebhookToken / validateFormWebhookToken in handler | none | checked | Own verification. |
| 53 | POST | `/api/elevenlabs/tools/play-audio/:token/:agentId` | URL token: validateAppointmentWebhookToken (inline, before any work); then audioUrl host check | none | checked | The #126 audit HIGH finding was stale. Token check is present. tests/security/play-audio-secret.test.mjs covers it. |

### `server/routes/core/user-limits-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 16 | GET | `/api/user/limits` | authenticateToken | none | checked | Per-route auth. |

### `server/routes/core/workforce-comms-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 31 | GET | `/api/workforce/health` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |

### `server/routes/crm-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 72 | GET | `/stages` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 82 | POST | `/stages` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 112 | PATCH | `/stages/:id` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 129 | DELETE | `/stages/:id` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 145 | POST | `/stages/reorder` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 165 | GET | `/sources` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 186 | GET | `/leads` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 228 | GET | `/leads/kanban` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 281 | GET | `/leads/ai-categories` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 301 | GET | `/leads/categorized` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 339 | GET | `/leads/category-counts` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 376 | GET | `/leads/ai-kanban` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 441 | GET | `/leads/ai-kanban/:category` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 474 | PATCH | `/leads/:id/ai-category` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 509 | POST | `/leads/:id/recategorize` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 540 | POST | `/leads/backfill-categories` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 574 | GET | `/leads/:id` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 590 | PATCH | `/leads/:id` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 625 | PATCH | `/leads/:id/stage` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 651 | POST | `/leads/bulk/ai-category` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 686 | POST | `/leads/bulk/stage` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 727 | POST | `/leads/bulk/tags` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 757 | POST | `/leads/bulk/assign` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 784 | GET | `/leads/:leadId/notes` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 795 | POST | `/leads/:leadId/notes` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 826 | PATCH | `/notes/:id` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 848 | DELETE | `/notes/:id` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 871 | GET | `/leads/:leadId/activities` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 882 | POST | `/leads/bulk/delete` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 908 | GET | `/analytics` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 922 | GET | `/export/csv` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 1025 | GET | `/tags` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 1039 | GET | `/preferences` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 1049 | PATCH | `/preferences` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 1078 | PATCH | `/preferences/color/:categoryId` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 1093 | PATCH | `/preferences/order` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |
| 1107 | PATCH | `/preferences/sort/:categoryId` | mount: authenticateHybrid (routes/core/crm-public-routes.ts:12) | requireAuth per route | checked | Mount-level auth, then route-level permission. |

### `server/routes/dead-letter-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 71 | GET | `/api/webhooks/dead-letters` | guards.authenticate, guards.requireCompanyScope, guards.requireApprover | guards.requireCompanyScope, guards.requireApprover | checked | Per-route auth. |

### `server/routes/email-settings-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 167 | GET | `/` | mount: checkAdminOrTeamMember, router.use (routes/core/admin-router-routes.ts:86) | admin or team member; requireAdminPermission('communications', | checked | Mount-level auth, then route-level permission. |
| 210 | POST | `/test-smtp` | mount: checkAdminOrTeamMember, router.use (routes/core/admin-router-routes.ts:86) | admin or team member; requireAdminPermission('communications', | checked | Mount-level auth, then route-level permission. |
| 264 | PUT | `/:eventType` | mount: checkAdminOrTeamMember, router.use (routes/core/admin-router-routes.ts:86) | admin or team member; requireAdminPermission('communications', | checked | Mount-level auth, then route-level permission. |
| 299 | PUT | `/` | mount: checkAdminOrTeamMember, router.use (routes/core/admin-router-routes.ts:86) | admin or team member; requireAdminPermission('communications', | checked | Mount-level auth, then route-level permission. |
| 340 | POST | `/save-smtp` | mount: checkAdminOrTeamMember, router.use (routes/core/admin-router-routes.ts:86) | admin or team member; requireAdminPermission('communications', | checked | Mount-level auth, then route-level permission. |
| 382 | POST | `/reinitialize` | mount: checkAdminOrTeamMember, router.use (routes/core/admin-router-routes.ts:86) | admin or team member; requireAdminPermission('communications', | checked | Mount-level auth, then route-level permission. |

### `server/routes/flow-automation/appointments.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 15 | GET | `/appointments` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 62 | POST | `/appointments` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 136 | PATCH | `/appointments/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 303 | POST | `/appointments/:id/sync-calendar` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 355 | DELETE | `/appointments/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 413 | GET | `/appointment-settings` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 493 | PUT | `/appointment-settings` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 621 | POST | `/appointments/sync` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/routes/flow-automation/executions.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 11 | GET | `/executions` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/routes/flow-automation/flow-test-call.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 652 | POST | `/flows/:id/test` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/routes/flow-automation/flows.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 17 | GET | `/flows` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 40 | GET | `/flows/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 67 | POST | `/flows` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 141 | PATCH | `/flows/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 658 | DELETE | `/flows/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 701 | POST | `/flows/:id/resync-first-message` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/routes/flow-automation/forms.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 12 | GET | `/forms` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 59 | GET | `/forms/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 92 | POST | `/forms` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 143 | PATCH | `/forms/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 201 | DELETE | `/forms/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 221 | GET | `/forms/:id/submissions` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/routes/flow-automation/queue.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 23 | GET | `/queue/:entryId` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 170 | DELETE | `/queue/:entryId` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/routes/flow-automation/templates.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 14 | GET | `/flow-templates` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 32 | POST | `/flow-templates/:templateId/clone` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 93 | POST | `/flows/:id/clone` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/routes/flow-automation/webhooks.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 14 | GET | `/webhooks` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 38 | POST | `/webhooks` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 73 | PATCH | `/webhooks/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 107 | DELETE | `/webhooks/:id` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 127 | GET | `/webhooks/:id/logs` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 162 | POST | `/webhooks/:id/test` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |
| 190 | POST | `/webhooks/logs/:logId/retry` | mount: authenticateHybrid (routes/core/user-service-routes.ts:19) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/routes/incoming-connections-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 45 | GET | `/` | authenticateHybrid | none | checked | Per-route auth. |
| 193 | POST | `/` | authenticateHybrid | none | checked | Per-route auth. |
| 610 | POST | `/:id/sync-webhook` | authenticateHybrid | none | checked | Per-route auth. |
| 698 | DELETE | `/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 784 | GET | `/:id/diagnose` | authenticateHybrid | none | checked | Per-route auth. |
| 983 | GET | `/validate-twilio` | authenticateHybrid | none | checked | Per-route auth. |

### `server/routes/invoice-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 33 | GET | `/:invoiceId/download` | authenticateHybrid | none | checked | Per-route auth. |
| 67 | GET | `/by-number/:invoiceNumber/download` | authenticateHybrid | none | checked | Per-route auth. |
| 101 | GET | `/admin/:invoiceId/download` | authenticateHybrid, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 129 | POST | `/admin/:transactionId/generate` | authenticateHybrid, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 188 | GET | `/transaction/:transactionId` | authenticateHybrid | none | checked | Per-route auth. |

### `server/routes/llm-models-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 31 | GET | `/` | mount: checkAdminOrTeamMember, router.use (routes/llm-models-routes.ts:28) | admin or team member; requireAdminPermission('settings', 'llm_ | checked | Mount-level auth, then route-level permission. |
| 46 | PATCH | `/:id` | mount: checkAdminOrTeamMember, router.use (routes/llm-models-routes.ts:28) | admin or team member; requireAdminPermission('settings', 'llm_ | checked | Mount-level auth, then route-level permission. |

### `server/routes/mercadopago-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 47 | GET | `/config` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 61 | POST | `/create-preference` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 140 | POST | `/verify-payment` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 229 | POST | `/create-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 283 | POST | `/confirm-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 394 | POST | `/cancel-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 438 | POST | `/webhook` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |

### `server/routes/metrics-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 17 | GET | `/metrics` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |

### `server/routes/notification-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 28 | GET | `/api/notifications` | authenticateHybrid | none | checked | Per-route auth. |
| 40 | GET | `/api/notifications/unread-count` | authenticateHybrid | none | checked | Per-route auth. |
| 51 | GET | `/api/notifications/banner` | authenticateHybrid | none | checked | Per-route auth. |
| 62 | PATCH | `/api/notifications/:id/read` | authenticateHybrid | none | checked | Per-route auth. |
| 78 | POST | `/api/notifications/read-all` | authenticateHybrid | none | checked | Per-route auth. |
| 89 | PATCH | `/api/notifications/:id/dismiss` | authenticateHybrid | none | checked | Per-route auth. |
| 105 | DELETE | `/api/notifications/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 121 | POST | `/api/admin/notifications/broadcast` | authenticateHybrid | none | checked | Per-route auth. |

### `server/routes/paypal-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 48 | GET | `/config` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 62 | POST | `/create-order` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 127 | POST | `/capture-order` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 226 | POST | `/create-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 291 | POST | `/confirm-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 402 | POST | `/cancel-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 446 | POST | `/webhook` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |

### `server/routes/paystack-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 49 | GET | `/config` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 63 | POST | `/initialize-transaction` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 134 | POST | `/verify-transaction` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 217 | POST | `/create-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 289 | POST | `/confirm-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 404 | POST | `/cancel-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 449 | POST | `/webhook` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |

### `server/routes/phone-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 47 | GET | `/api/twilio/addresses` | authenticateHybrid | none | checked | Per-route auth. |
| 66 | GET | `/api/twilio/address-requirements/:country` | authenticateHybrid | none | checked | Per-route auth. |
| 90 | GET | `/api/phone-numbers` | authenticateHybrid | none | checked | Per-route auth. |
| 117 | GET | `/api/phone-numbers/search` | authenticateHybrid | none | checked | Per-route auth. |
| 156 | GET | `/api/phone-numbers/search/:areaCode` | authenticateHybrid | none | checked | Per-route auth. |
| 184 | POST | `/api/phone-numbers/buy` | authenticateToken | none | checked | Per-route auth. |
| 631 | DELETE | `/api/phone-numbers/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 674 | GET | `/api/admin/phone-numbers/search/:areaCode` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 694 | POST | `/api/admin/phone-numbers/buy-system` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |

### `server/routes/platform-languages-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 36 | GET | `/` | none | none | not applicable | Public read (platformLanguagesPublicRouter). |
| 53 | GET | `/` | mount: checkSuperAdmin (routes/platform-languages-routes.ts:50) | superadmin | checked | Mount auth. |
| 68 | POST | `/` | mount: checkSuperAdmin (routes/platform-languages-routes.ts:50) | superadmin | checked | Mount auth. |
| 121 | PATCH | `/:id` | mount: checkSuperAdmin (routes/platform-languages-routes.ts:50) | superadmin | checked | Mount auth. |
| 200 | DELETE | `/:id` | mount: checkSuperAdmin (routes/platform-languages-routes.ts:50) | superadmin | checked | Mount auth. |
| 232 | POST | `/seed` | mount: checkSuperAdmin (routes/platform-languages-routes.ts:50) | superadmin | checked | Mount auth. |
| 279 | POST | `/add-key` | mount: checkSuperAdmin (routes/platform-languages-routes.ts:50) | superadmin | checked | Mount auth. |
| 339 | POST | `/delete-key` | mount: checkSuperAdmin (routes/platform-languages-routes.ts:50) | superadmin | checked | Mount auth. |

### `server/routes/plugin-installer.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 105 | POST | `/validate` | mount: checkAdminOrTeamMember (routes/core/plugin-management-routes.ts:12) | admin or team member; requireAdminPermission('settings', 'plug | checked | Mount-level auth, then route-level permission. |
| 194 | POST | `/install` | mount: checkAdminOrTeamMember (routes/core/plugin-management-routes.ts:12) | admin or team member; requireAdminPermission('settings', 'plug | checked | Mount-level auth, then route-level permission. |
| 444 | DELETE | `/uninstall/:name` | mount: checkAdminOrTeamMember (routes/core/plugin-management-routes.ts:12) | admin or team member; requireAdminPermission('settings', 'plug | checked | Mount-level auth, then route-level permission. |
| 507 | POST | `/run-migration/:name` | mount: checkAdminOrTeamMember (routes/core/plugin-management-routes.ts:12) | admin or team member; requireAdminPermission('settings', 'plug | checked | Mount-level auth, then route-level permission. |
| 583 | GET | `/installed` | mount: checkAdminOrTeamMember (routes/core/plugin-management-routes.ts:12) | admin or team member | checked | Mount-level auth, then route-level permission. |
| 652 | GET | `/download/:filename` | mount: checkAdminOrTeamMember (routes/core/plugin-management-routes.ts:12) | admin or team member; requireAdminPermission('settings', 'plug | checked | Mount-level auth, then route-level permission. |

### `server/routes/plugin-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 79 | GET | `/capabilities` | mount: authenticateAnyToken (routes/core/plugin-management-routes.ts:22) | any signed-in user | checked | userPluginRouter. |
| 182 | GET | `/health` | none | none | not applicable | Public by design (publicPluginRouter: health, docs, bundle). |
| 280 | GET | `/:name/docs` | none | none | not applicable | Public by design (publicPluginRouter: health, docs, bundle). |
| 310 | GET | `/:name/bundle` | none | none | not applicable | Public by design (publicPluginRouter: health, docs, bundle). |
| 424 | GET | `/` | mount: checkAdminOrTeamMember + requireAdminPermission (routes/core/plugin-management-routes.ts:17) | admin | checked | Mount auth. |
| 450 | GET | `/:name` | mount: checkAdminOrTeamMember + requireAdminPermission (routes/core/plugin-management-routes.ts:17) | admin | checked | Mount auth. |
| 490 | PUT | `/:name/enable` | mount: checkAdminOrTeamMember + requireAdminPermission (routes/core/plugin-management-routes.ts:17) | admin | checked | Mount auth. |
| 532 | PUT | `/:name/disable` | mount: checkAdminOrTeamMember + requireAdminPermission (routes/core/plugin-management-routes.ts:17) | admin | checked | Mount auth. |
| 574 | GET | `/discover/available` | mount: checkAdminOrTeamMember + requireAdminPermission (routes/core/plugin-management-routes.ts:17) | admin | checked | Mount auth. |

### `server/routes/public-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 63 | GET | `/api/installer/status` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 77 | GET | `/api/init` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 137 | GET | `/api/installer/check` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 196 | POST | `/api/installer/install` | none; refuses with 403 once installed | none | not applicable | Public by design. Only works before the first install. |
| 304 | GET | `/api/health` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 312 | GET | `/api/system/version` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 329 | GET | `/api/diagnostic` | authenticateToken, requireRole('admin') | requireRole('admin') | checked | Per-route auth. |
| 363 | POST | `/api/diagnostic/grant-admin` | none; always 410 Gone | none | not applicable | Endpoint removed. |
| 371 | GET | `/api/settings/public` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 414 | GET | `/api/settings/llm-margin` | none | none | open | Public. Returns the LLM margin percentage. client/src/pages/Agents.tsx uses it. Open decision: keep public or require auth. |
| 425 | GET | `/api/settings/voice-engine` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 458 | GET | `/api/settings/payment-gateway` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 607 | GET | `/api/branding` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 707 | GET | `/sitemap.xml` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 760 | GET | `/robots.txt` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 813 | GET | `/api/public/stats` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 856 | GET | `/api/public/seo` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 943 | GET | `/api/public/analytics-scripts` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 976 | POST | `/api/contact` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |
| 1092 | GET | `/api/twilio-countries` | none | none | not applicable | Public by design (catalog, health, config or static data). No account data returned. |

### `server/routes/rag-knowledge-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 253 | GET | `/storage` | authenticateToken | none | checked | Per-route auth. |
| 272 | GET | `/` | authenticateToken | none | checked | Per-route auth. |
| 303 | POST | `/upload` | authenticateToken | none | checked | Per-route auth. |
| 381 | POST | `/url` | authenticateToken | none | checked | Per-route auth. |
| 468 | POST | `/text` | authenticateToken | none | checked | Per-route auth. |
| 524 | DELETE | `/:id` | authenticateToken | none | checked | Per-route auth. |
| 547 | GET | `/:id/status` | authenticateToken | none | checked | Per-route auth. |
| 573 | POST | `/search` | authenticateToken, requireCompanyScope | requireCompanyScope | checked | Per-route auth. |
| 615 | POST | `/tool-webhook` | Bearer WEBHOOK_TOKEN, constant-time compare (fixed in #126); 503 when unset | none | checked | Own verification. Mount is public because this route is exempt from the /api hybrid gate. |

### `server/routes/razorpay-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 50 | GET | `/config` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 72 | POST | `/create-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 146 | POST | `/verify-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 260 | POST | `/create-order` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 335 | POST | `/verify-order` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 410 | POST | `/cancel-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 441 | POST | `/webhook` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |

### `server/routes/refund-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 200 | POST | `/:transactionId` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 426 | GET | `/:id/download` | authenticateToken | none | checked | Per-route auth. |
| 474 | GET | `/:id` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 509 | GET | `/` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 544 | GET | `/user/my-refunds` | authenticateToken | none | checked | Per-route auth. |
| 571 | GET | `/admin/:id/download` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 611 | GET | `/user/:id/download` | authenticateToken | none | checked | Per-route auth. |

### `server/routes/stripe-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 96 | GET | `/config` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 111 | POST | `/create-payment-intent` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 186 | POST | `/confirm-payment` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 245 | POST | `/create-checkout-session` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 367 | POST | `/change-plan` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 456 | POST | `/reactivate-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 498 | POST | `/cancel-subscription` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |
| 534 | POST | `/webhook` | n/a | n/a | not applicable | Not mounted. No import reaches this file, so it is not served. |

### `server/routes/subscription-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 32 | GET | `/api/plans` | none | none | not applicable | Public catalog. |
| 43 | GET | `/api/subscriptions/plans` | authenticateHybrid | none | checked | Per-route auth. |
| 58 | GET | `/api/subscriptions/my-subscription` | authenticateHybrid | none | checked | Per-route auth. |
| 69 | GET | `/api/user-subscription` | authenticateHybrid | none | checked | Per-route auth. |
| 84 | GET | `/api/credit-packages` | none | none | not applicable | Public catalog. |
| 99 | GET | `/api/credits/transactions` | authenticateHybrid | none | checked | Per-route auth. |
| 110 | GET | `/api/credit-transactions` | authenticateHybrid | none | checked | Per-route auth. |
| 121 | GET | `/api/credit-transactions/export` | authenticateHybrid | none | checked | Per-route auth. |
| 154 | GET | `/api/billing-profile` | authenticateHybrid | none | checked | Per-route auth. |
| 177 | PUT | `/api/billing-profile` | authenticateHybrid | none | checked | Per-route auth. |

### `server/routes/template-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 33 | GET | `/api/prompt-templates` | authenticateHybrid | none | checked | Per-route auth. |
| 70 | GET | `/api/prompt-templates/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 93 | POST | `/api/prompt-templates` | authenticateHybrid | none | checked | Per-route auth. |
| 158 | PATCH | `/api/prompt-templates/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 214 | DELETE | `/api/prompt-templates/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 234 | POST | `/api/prompt-templates/:id/use` | authenticateHybrid | none | checked | Per-route auth. |
| 285 | POST | `/api/admin/prompt-templates/system` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |

### `server/routes/transactions-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 33 | GET | `/` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 94 | GET | `/analytics` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 137 | GET | `/history` | authenticateToken | none | checked | Per-route auth. |
| 202 | GET | `/:id` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 235 | GET | `/user/history` | authenticateToken | none | checked | Per-route auth. |
| 279 | GET | `/refunds/all` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 315 | GET | `/invoices/all` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 339 | GET | `/user/invoices` | authenticateToken | none | checked | Per-route auth. |
| 351 | GET | `/invoice/:id` | authenticateToken | none | checked | Per-route auth. |
| 373 | GET | `/webhooks/queue` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |
| 393 | GET | `/export/zip` | authenticateToken, requireRole("admin") | requireRole("admin") | checked | Per-route auth. |

### `server/routes/user-address-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 24 | GET | `/api/user/addresses` | authenticateHybrid | none | checked | Per-route auth. |
| 40 | POST | `/api/user/addresses` | authenticateHybrid | none | checked | Per-route auth. |
| 91 | GET | `/api/user/addresses/:id/refresh` | authenticateHybrid | none | checked | Per-route auth. |
| 178 | DELETE | `/api/user/addresses/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 212 | GET | `/api/user/addresses/countries` | authenticateHybrid | none | checked | Per-route auth. |

### `server/routes/user-sip-gateways.routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 174 | GET | `/api/user/sip-gateways` | auth | none | checked | Per-route auth. |
| 206 | POST | `/api/user/sip-gateways` | auth | none | checked | Per-route auth. |
| 231 | PUT | `/api/user/sip-gateways/:id` | auth | none | checked | Per-route auth. |
| 267 | DELETE | `/api/user/sip-gateways/:id` | auth | none | checked | Per-route auth. |
| 290 | POST | `/api/user/sip-gateways/:id/activate` | auth | none | checked | Per-route auth. |
| 325 | GET | `/api/user/sip-phone-numbers` | auth | none | checked | Per-route auth. |
| 357 | POST | `/api/user/sip-phone-numbers` | auth | none | checked | Per-route auth. |
| 406 | PUT | `/api/user/sip-phone-numbers/:id` | auth | none | checked | Per-route auth. |
| 449 | DELETE | `/api/user/sip-phone-numbers/:id` | auth | none | checked | Per-route auth. |

### `server/routes/user-webhook-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 42 | GET | `/api/webhooks/limits` | authenticateHybrid | none | checked | Per-route auth. |
| 60 | POST | `/api/webhooks` | authenticateHybrid | none | checked | Per-route auth. |
| 145 | GET | `/api/webhooks` | authenticateHybrid | none | checked | Per-route auth. |
| 156 | GET | `/api/webhooks/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 171 | PATCH | `/api/webhooks/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 201 | DELETE | `/api/webhooks/:id` | authenticateHybrid | none | checked | Per-route auth. |
| 217 | POST | `/api/webhooks/:id/test` | authenticateHybrid | none | checked | Per-route auth. |
| 253 | GET | `/api/webhooks/:id/logs` | authenticateHybrid | none | checked | Per-route auth. |
| 271 | POST | `/api/webhooks/logs/:logId/retry` | authenticateHybrid | none | checked | Per-route auth. |

### `server/routes/workforce-roster-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 73 | GET | `/api/workforce/agents` | guards.authenticate, guards.requireCompanyScope, guards.requireApprover | guards.requireCompanyScope, guards.requireApprover | checked | Per-route auth. |

### `server/services/google-calendar/google-calendar.routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 70 | GET | `/auth` | mount: authenticateToken (routes/core/integration-routes.ts:22) | owner from session | checked | Mount-level auth, then route-level permission. |
| 108 | POST | `/exchange` | mount: authenticateToken (routes/core/integration-routes.ts:22) | owner from session | checked | Mount-level auth, then route-level permission. |
| 219 | GET | `/status` | mount: authenticateToken (routes/core/integration-routes.ts:22) | owner from session | checked | Mount-level auth, then route-level permission. |
| 229 | DELETE | `/disconnect` | mount: authenticateToken (routes/core/integration-routes.ts:22) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/services/google-sheets/google-sheets.routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 78 | GET | `/auth` | mount: authenticateToken (routes/core/integration-routes.ts:18) | owner from session | checked | Mount-level auth, then route-level permission. |
| 119 | POST | `/exchange` | mount: authenticateToken (routes/core/integration-routes.ts:18) | owner from session | checked | Mount-level auth, then route-level permission. |
| 235 | GET | `/status` | mount: authenticateToken (routes/core/integration-routes.ts:18) | owner from session | checked | Mount-level auth, then route-level permission. |
| 246 | DELETE | `/disconnect` | mount: authenticateToken (routes/core/integration-routes.ts:18) | owner from session | checked | Mount-level auth, then route-level permission. |
| 257 | GET | `/sheets` | mount: authenticateToken (routes/core/integration-routes.ts:18) | owner from session | checked | Mount-level auth, then route-level permission. |
| 268 | GET | `/sheets/:spreadsheetId/tabs` | mount: authenticateToken (routes/core/integration-routes.ts:18) | owner from session | checked | Mount-level auth, then route-level permission. |

### `server/workforce/runtime/company-controls-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 211 | GET | `/api/workforce/company-controls` | guards.authenticate, guards.requireAdmin, guards.requireCompanyScope | guards.requireAdmin, guards.requireCompanyScope | checked | Per-route auth. |
| 236 | PUT | `/api/workforce/company-controls` | guards.authenticate, guards.requireAdmin, guards.requireCompanyScope | guards.requireAdmin, guards.requireCompanyScope | checked | Per-route auth. |
| 308 | GET | `/api/workforce/usage` | guards.authenticate, guards.requireAdmin, guards.requireCompanyScope | guards.requireAdmin, guards.requireCompanyScope | checked | Per-route auth. |

### `server/workforce/runtime/metrics-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 62 | GET | `/api/workforce/metrics` | guards.authenticate, guards.requireAdmin, guards.requireCompanyScope | guards.requireAdmin, guards.requireCompanyScope | checked | Per-route auth. |

### `server/workforce/runtime/shadow-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 98 | GET | `/api/workforce/shadow-changes/pending` | guards.authenticate, guards.requireCompanyScope, guards.requireApprover | guards.requireCompanyScope, guards.requireApprover | checked | Per-route auth. |
| 127 | POST | `<path>` | guards.authenticate, guards.requireCompanyScope, guards.requireApprover | guards.requireCompanyScope, guards.requireApprover | checked | Per-route auth. |

### `server/workforce/runtime/task-board-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 185 | GET | `/api/workforce/tasks` | guards.authenticate, guards.requireCompanyScope, guards.requireAdminOrManager | guards.requireCompanyScope, guards.requireAdminOrManager | checked | Per-route auth. |
| 200 | GET | `/api/workforce/run-history` | guards.authenticate, guards.requireCompanyScope, guards.requireAdminOrManager | guards.requireCompanyScope, guards.requireAdminOrManager | checked | Per-route auth. |

### `server/workforce/runtime/workforce-admin-routes.ts`

| Line | Method | Route | Auth middleware | Permission check | Status | Reason |
|---|---|---|---|---|---|---|
| 162 | GET | `/api/workforce/review-inbox` | guards.authenticate, guards.requireAdmin, guards.requireCompanyScope | guards.requireAdmin, guards.requireCompanyScope | checked | Per-route auth. |
| 221 | POST | `/api/workforce/agents/:agentId/pause` | guards.authenticate, guards.requireAdmin, guards.requireCompanyScope | guards.requireAdmin, guards.requireCompanyScope | checked | Per-route auth. |
| 222 | POST | `/api/workforce/agents/:agentId/resume` | guards.authenticate, guards.requireAdmin, guards.requireCompanyScope | guards.requireAdmin, guards.requireCompanyScope | checked | Per-route auth. |
| 226 | POST | `/api/workforce/agents` | guards.authenticate, guards.requireManager ?? guards.requireAdmin, guards.requireCompanyScope | guards.requireManager ?? guards.requireA, guards.requireCompanyScope | checked | Per-route auth. |
| 262 | PATCH | `/api/workforce/agents/:agentId` | guards.authenticate, guards.requireManager ?? guards.requireAdmin, guards.requireCompanyScope | guards.requireManager ?? guards.requireA, guards.requireCompanyScope | checked | Per-route auth. |
| 294 | POST | `/api/workforce/agents/:agentId/retire` | guards.authenticate, guards.requireManager ?? guards.requireAdmin, guards.requireCompanyScope | guards.requireManager ?? guards.requireA, guards.requireCompanyScope | checked | Per-route auth. |
