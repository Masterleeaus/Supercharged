# agent-embed routes plan

Not mounted yet. The lead mounts these after the company_id and widget-link wiring is done. Paths are relative to the platform origin (for example `https://PLATFORM`).

## Auth model

| Caller | Credential | Checked by |
|---|---|---|
| Host page loader (`embed-script.js`) | None. Browser sends `Origin` automatically. | Origin must be in the agent's `allowedOrigins` (exact match, no wildcards). |
| Iframe chat (`/frame` shell) | `Authorization: Bearer <embed token>` from `POST /embed/:agentId/session` | `verifyEmbedToken`: HMAC signature, expiry (max 900 s, default 300 s), `agentId`, `companyId`, required capability. |
| Dashboard admin (managing allowlists) | Existing `requireAuth` session | Existing user session. Not part of this module. |

Rules that apply to every route in this module:
- CORS echoes a specific `Origin` only when it is in the allowlist. Never `*`. Always send `Vary: Origin`.
- An unknown agent and a disabled agent return the same 404 body, so the API does not reveal which agents exist.
- Responses never include `companyId`, `allowedOrigins`, the secret, or any provider credential.
- Logs record the route, agentId, origin and a reason code. They never record tokens or the secret.

## New routes (this module)

| Method and path | Auth | Purpose | Notes |
|---|---|---|---|
| `GET /embed/embed-script.js` | None | Serves `server/modules/agent-embed/embed-script.js` as `application/javascript`. | `Cache-Control: public, max-age=300`. No CORS needed for a script tag. |
| `GET /embed/:agentId/config` | Origin allowlist | Returns `{ displayName, enabled, capabilities, theme }`. | 403 if origin missing or not allowed. 404 if agent unknown or disabled. |
| `POST /embed/:agentId/session` | Origin allowlist | Loads the agent, checks `enabled` and `companyId`, mints a token with `issueEmbedToken(agentId, companyId, origin, capabilities, ttl 300)`. Returns `{ token, expiresAt, frameUrl }`. | `frameUrl` is `https://PLATFORM/embed/:agentId/frame`. The token is never placed in a URL. Rate limit per IP and agentId. |
| `GET /embed/:agentId/frame` | None (shell is static) | HTML shell for the iframe. Contains no secret. Posts `{source:'agent-embed', type:'ready'}` to `window.parent`. Receives the token by postMessage from the parent, checking `event.origin` and `event.source`. | Sets `Content-Security-Policy: frame-ancestors <allowedOrigins>` for this agent, or `'none'` when disabled. Do not send `X-Frame-Options`, because CSP takes over. |
| `POST /embed/:agentId/chat/start` | Bearer, cap `chat` | Delegates to the logic of `POST /widget/session/start`. Returns `{ sessionId, sessionToken }`. | Needs the agent-to-widget link (see wiring below). |
| `POST /embed/:agentId/chat/:sessionId/connect` | Bearer, cap `chat` | Delegates to `POST /widget/session/:sessionId/connect`. | Also checks that the session belongs to this agent. |
| `POST /embed/:agentId/chat/:sessionId/heartbeat` | Bearer, cap `chat` | Delegates to the heartbeat route. | |
| `POST /embed/:agentId/chat/:sessionId/end` | Bearer, cap `chat` | Delegates to the end route. | |
| `POST /embed/:agentId/chat/:sessionId/ephemeral-token` | Bearer, cap `chat` | Delegates to the ephemeral-token route. | **Decision needed.** This issues a provider credential to the browser. The embed layer does not add it, but it is the one place a browser holds a provider token. Confirm before mounting. |
| `POST /embed/:agentId/booking` | Bearer, cap `booking` | Delegates to `POST /widget/session/:sessionId/book-appointment`. | Body must include `sessionId`, which must belong to this agent. |
| `POST /embed/:agentId/knowledge` | Bearer, cap `knowledge` | Delegates to `POST /widget/session/:sessionId/knowledge-lookup`. | Same session-ownership check. |

## Known limitation: origin on chat calls

Browsers do not let the iframe send the host page's origin. Calls from the frame carry the platform origin. So the origin is bound when the token is minted, which is the enforced check. On chat calls the token is checked for signature, expiry, agentId, companyId and capability. The short TTL (300 s) limits replay. If the lead wants a stronger binding, the frame can send the origin it was given in the token message, and the server can compare it with the signed claim. That is a consistency check only, not a browser-enforced binding.

## Existing widget routes reused (do not change)

These sit in `server/modules/widget/public-widget-routes.ts` and are called server-side by the adapter routes above.

- `POST /widget/session/start`
- `POST /widget/session/:sessionId/connect`
- `POST /widget/session/:sessionId/heartbeat`
- `POST /widget/session/:sessionId/end`
- `POST /widget/session/:sessionId/ephemeral-token`
- `POST /widget/session/:sessionId/book-appointment`
- `POST /widget/session/:sessionId/knowledge-lookup`
- `GET /widget/config/:token` (not used by the new flow. Its domain check and CORS wildcard are covered in PENDING-WIDGET-PATCH.md.)

Service helpers to reuse: `widgetService.checkCooldown`, `checkUserCredits`, `checkBusinessHours`. Do not reuse `widgetService.validateDomain` as the origin check. It allows every domain when the list is empty (see PENDING-WIDGET-PATCH.md).

Not reused: `GET /widgets/:id/embed-code` (auth-protected; generates the old snippet that points at a missing `/widget/embed.js`).

## Wiring the lead must add (not done here)

1. **company_id.** `shared/schema.ts` `agents` has `userId` but no company column. Add one (or an `agent_embed_settings` table with `agent_id`, `company_id`, `enabled`, `allowed_origins text[]`, `capabilities text[]`, `theme jsonb`). Reject creating a session when `company_id` is null. This needs a migration. Not run here.
2. **agent-to-widget link.** The reused widget routes key on a `website_widgets` row (`embed_token`, `user_id`, `allowed_domains`). Store the widget id on the embed settings row, or create one per agent.
3. **Secret.** Set `AGENT_EMBED_TOKEN_SECRET` (at least 32 characters). `readEmbedSecret()` reads it. Without it the module must refuse to mount.
4. **Platform base URL.** Use the server's public origin for `frameUrl`, not the request Host header.
5. **Frame shell.** The HTML for `/embed/:agentId/frame` is not written yet.

## Mount sketch (for the lead, not active)

```ts
// server/modules/agent-embed/index.ts (to be written when mounting)
// app.use('/', agentEmbedRouter);   // router defines the paths above
```
