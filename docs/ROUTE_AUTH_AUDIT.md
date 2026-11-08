# Route Auth Audit (step 1: missing authentication middleware)

Scope: mount points in `server/routes.ts` and `server/index.ts`, plus the router files they mount. Read-only audit. No code was changed.

Legend: **per-route** = auth middleware on each handler line; **mount** = middleware passed in `app.use(path, mw, router)` or `router.use(mw)`; **NONE** = no auth found on the handler line, the router, or the mount above it.

## Global middleware (server/index.ts, server/routes.ts)

- `index.ts`: compression, json, cookie parser, helmet, correlation id, request logger. None of these authenticate.
- `index.ts` static: `/uploads`, `/images`, `/audio`, `/widget` (public static).
- `routes.ts:181` `maintenanceMiddleware` (503 for non-admin during updates; not an auth check).
- `routes.ts:197` `getTeamContextMiddleware()` on `/api`, only when the Team Management plugin is installed.
- `routes.ts:1700` `hybridGateUnlessExempt(authenticateHybrid)` on `/api`. It guards every `/api` request that reaches widget routes and later. Only `POST /rag-knowledge/tool-webhook` is exempt.

## Mounted routers

| # | Mount path | Router file | Auth found | Public by design? | Flag |
|---|---|---|---|---|---|
| 1 | (root) | server/routes/public-routes.ts (20 routes) | NONE on most; rate limiter only | Yes: installer, init, health, settings, branding, SEO, contact, twilio-countries | OK. Review `/api/settings/llm-margin` and `/api/settings/payment-gateway` for data exposure |
| 2 | (root) | server/routes/auth-routes.ts (17) | NONE; authRateLimiter on some | Yes: login, register, OTP, refresh, logout | OK |
| 3 | (root) | server/routes/agent-routes.ts (17) | per-route authenticateToken | No | OK |
| 4 | (root) | server/routes/campaign-routes.ts (22) | per-route | No | OK |
| 5 | (root) | server/routes/phone-routes.ts (9) | per-route | No | OK |
| 6 | (root) | server/routes/user-address-routes.ts (5) | per-route | No | OK |
| 7 | (root) | server/routes/analytics-routes.ts (8) | per-route | No | OK |
| 8 | (root) | server/routes/notification-routes.ts (8) | per-route | No | OK |
| 9 | (root) | server/integrations/titan-field/route.ts | NONE; env gate (503 unless shadow mode); signature checked in receiver | Signed bridge | REVIEW: receiver.mjs not read |
| 10 | (root) | server/integrations/titan-field/local-link-route.ts | NONE; env gate; HMAC verified in handler | Signed | OK |
| 11 | (root) | server/routes/user-webhook-routes.ts (9) | per-route | No | OK |
| 12 | (root) | server/routes/user-sip-gateways.routes.ts (9) | per-route `auth` (= authenticateToken) | No | OK |
| 13 | (root) | server/routes/template-routes.ts (7) | per-route | No | OK |
| 14 | (root) | server/routes/subscription-routes.ts (10) | per-route; `/api/plans`, `/api/credit-packages` NONE | Yes for the two catalog routes | OK |
| 15 | (root) | server/engines/plivo/routes/plivo-api.ts | per-route requireAuth / requireAdminAuth + requireAdminPermission | No | OK |
| 16 | (root) | server/engines/plivo/routes/plivo-webhooks.ts (`setupPlivoWebhooks`) | verifyPlivo on POSTs; NONE on `GET /api/plivo/incoming`, `GET /api/plivo/voice/transfer` | Webhook | REVIEW: unsigned GET variants return XML or status |
| 17 | (root) | server/engines/plivo-elevenlabs (`initPlivoElevenLabsEngine`) | not read | n/a | REVIEW |
| 18 | /api/twilio-openai | server/engines/twilio-openai/routes/twilio-openai-webhooks.ts | validateTwilioWebhook on `/voice/*` | Webhook | OK |
| 19 | /api/twilio-openai/incoming-connections | server/engines/twilio-openai/routes/twilio-openai-incoming-connections.ts (4) | mount authenticateToken + per-route | No | OK |
| 20 | (root) | server/engines/kyc/routes/kyc-routes.ts (`registerKycRoutes`, 11) | per-route requireAuth / requireAdmin | No | OK |
| 21 | (root) | plugins/sip-engine (dynamic import) | sessionAuthMiddleware injected; plugin code not read | n/a | REVIEW |
| 22 | (root) | plugins/rest-api (dynamic import) | injected; plugin code not read | n/a | REVIEW |
| 23 | (root) | plugins/loader (`loadPlugins`) | not read | n/a | REVIEW |
| 24 | /api/admin/plugins/installer | server/routes/plugin-installer.ts | mount checkAdminOrTeamMember | No | OK |
| 25 | /api/admin/plugins | server/routes/plugin-routes.ts (default) | mount checkAdminOrTeamMember + requireAdminPermission | No | OK |
| 26 | /api/plugins (public) | server/routes/plugin-routes.ts (publicPluginRouter) | NONE: health, docs, bundle | Yes (per file comment) | OK |
| 27 | /api/plugins (user) | server/routes/plugin-routes.ts (userPluginRouter) | mount authenticateAnyToken | No | OK |
| 28 | /api/stripe | server/engines/payment/gateways/stripe/routes.ts | per-route; `/config` and `/webhook` NONE | Yes for config and webhook | OK |
| 29 | /api/razorpay | server/engines/payment/gateways/razorpay/routes.ts | per-route; `/config`, `/webhook` NONE | Yes for config and webhook | OK |
| 30 | /api/paypal | server/engines/payment/gateways/paypal/routes.ts | per-route; `/config`, `/webhook` NONE | Yes for config and webhook | OK |
| 31 | /api/paystack | server/routes/paystack-routes.ts | per-route; `/config`, `/webhook` NONE | Yes for config and webhook | OK |
| 32 | /api/mercadopago | server/engines/payment/gateways/mercadopago/routes.ts | per-route; `/config`, `/webhook` NONE | Yes for config and webhook | OK |
| 33 | /api/yookassa | server/engines/payment/gateways/yookassa/routes.ts | per-route; `/config` NONE | Yes for config | OK |
| 34 | /api/admin | server/routes/admin-team-access.routes.ts (1) | per-route checkAdminOrTeamMember + requireAdminPermission | No | OK |
| 35 | /api/admin | server/routes/admin-routes.ts (2) | router.use(checkAdminOrTeamMember) | No | OK |
| 36 | /api/admin/llm-models | server/routes/llm-models-routes.ts (2) | router.use(checkAdminOrTeamMember) + per-route | No | OK |
| 37 | /api/admin/platform-languages | server/routes/platform-languages-routes.ts | router.use(checkSuperAdmin) | No | OK |
| 38 | /api/admin/transactions, /api/transactions | server/routes/transactions-routes.ts (11) | per-route | No | OK |
| 39 | /api/admin/refunds | server/routes/refund-routes.ts (7) | per-route | No | OK |
| 40 | (inline) /api/refunds/:id/download | server/routes.ts:1590 | per-route authenticateToken | No | OK |
| 41 | /api/admin/email-settings | server/routes/email-settings-routes.ts (6) | router.use(checkAdminOrTeamMember) | No | OK |
| 42 | /api/audio | server/routes/audio-routes.ts (2) | per-route authenticateHybrid | No | OK |
| 43 | /api/invoices | server/routes/invoice-routes.ts (5) | per-route authenticateHybrid | No | OK |
| 44 | /api/flow-automation | server/routes/flow-automation-routes.ts (34) | mount authenticateHybrid | No | OK |
| 45 | /api/incoming-connections | server/routes/incoming-connections-routes.ts (6) | per-route authenticateHybrid | No | OK |
| 46 | /api/crm | server/routes/crm-routes.ts (37) | mount authenticateHybrid + per-route requireAuth | No | OK |
| 47 | /api/public/platform-languages | server/routes/platform-languages-routes.ts (public router) | NONE | Yes | OK |
| 48 | /api/public | server/modules/widget/public-widget-routes.ts | apiRateLimiter; widget token in path | Yes | OK |
| 49 | /api (widget) | server/modules/widget/widget-routes.ts | hybridGateUnlessExempt(authenticateHybrid) + per-route requireAuth | No | OK |
| 50 | /api/rag-knowledge | server/routes/rag-knowledge-routes.ts (9) | per-route authenticateHybrid; `/tool-webhook` NONE, checks WEBHOOK_TOKEN itself | Webhook (gate-exempt) | OK |
| 51 | /api/integrations/google | server/services/google-sheets/google-sheets.routes.ts (6) | mount authenticateToken; `/auth`, `/exchange` sit under it | No | OK |
| 52 | /api/google-calendar | server/services/google-calendar/google-calendar.routes.ts (4) | mount authenticateToken | No | OK |
| 53 | (inline) /api/webhooks/*, /api/elevenlabs/tools/play-audio/:agentId | server/routes.ts:1525-1547 | Twilio: validateTwilioWebhook; ElevenLabs webhook: signature check in handler; appointment and form: URL token; **play-audio: NONE, no token check in handler** | Play-audio is an agent tool route, not a provider webhook | **HIGH** |
| 54 | (inline) stream proxy GETs /api/twilio-openai/stream*, /api/webhooks/twilio/stream*, /api/plivo/stream*, /api/plivo-elevenlabs/stream* | server/routes.ts:1671-1697 | NONE; re-emits upgrade to WS handlers | WS upgrade | REVIEW: WS handler auth not read |

Not mounted: `server/routes/metrics-routes.ts` (no import or mount in routes.ts).

## HIGH findings

1. **POST /api/elevenlabs/tools/play-audio/:agentId** (server/routes.ts:1547, handler `handlePlayAudioToolWebhook` in server/routes/webhook-routes.ts:6091). No route-level auth. The handler looks up the agent by its ElevenLabs ID and then plays `audioUrl` from the body. There is no token or signature check. Compare the appointment and form tool routes, which validate a URL token.

## Counts

- Mounted router objects and mount rows: 54 rows above (includes middleware-only and inline rows).
- Routers with NONE that are not public by design: 1 (play-audio, HIGH). Review-only: rows 9, 16, 17, 21, 22, 23, 54.
