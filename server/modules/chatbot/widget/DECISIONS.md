# Public widget: decisions

Slice: `server/modules/chatbot/widget/` (server) and `client/src/widget/` (browser). Source: Commerce Crew
`extensions/chatbot/resources/assets/js/external-chatbot.js`, `frame.blade.php`, `System/Http/Controllers/Api/ChatbotFrameController.php`,
and the trusted-domain migration `2026_02_13_083015_add_trusted_domains_to_ext_chatbots_table.php`.

## Files

| File | Role |
| --- | --- |
| `origin.ts` | Origin and trusted-domain rules. Pure. |
| `config.ts` | `toWidgetPublicConfig`: allowlist projection to `WidgetPublicConfig`. |
| `embed-token.ts` | `createEmbedTokenIssuer`, `createEmbedTokenVerifier`. HMAC-SHA256, fails closed. |
| `rate-limit.ts` | Fixed-window limiter, in memory, bounded. |
| `handlers.ts` | Route logic (no Express): config, session, message, preflight. Flag gate. |
| `storage.ts` | Drizzle storage and tenant-scoped query builders. |
| `index.ts` | Barrel for the owner's wiring step. |
| `db/widget.ts` | Drizzle tables `widget_chatbot_configs`, `widget_embed_keys`. |
| `db/migrations-draft/0201_widget.sql` | Draft migration, not applied. |
| `client/src/widget/*.ts` | Browser widget: `index` (entry), `api`, `visitor`, `widget` (view), `dom`, `styles`. |

## Decisions that change behaviour

1. **Trusted domains fail closed.** The legacy widget let through any chatbot with an empty trusted list. Here an empty list refuses every origin.
2. **Origin comes from the Origin header.** The legacy check used `window.location.hostname` in the embedding page, which the page controls. Here the server reads the `Origin` header, and a missing Origin is refused.
3. **Origins must be https.** `http` is accepted only for `localhost` and `127.0.0.1`, for local development.
4. **No wildcard trusted domains.** Each entry is one hostname, with an optional port. A port-less entry matches only the default port.
5. **Config refusal is generic.** An untrusted origin gets 403 `origin_not_trusted`. A missing chatbot gets 404. Neither body reveals a token, id or secret.
6. **Public config is an allowlist.** `toWidgetPublicConfig` copies the eleven `WidgetPublicConfig` fields one by one. The legacy resource returned Shopify and WooCommerce tokens and consumer secrets. None of those are read here.
7. **assetBaseUrl comes from server configuration**, not from the tenant record, as the contract requires.
8. **Colour, language, position and title are sanitised** on the server and checked again in the browser. A bad colour falls back to `#763ed1`. Control characters are removed.
9. **Embed token format:** `v1.<base64url claims>.<base64url HMAC-SHA256>`. The key is per company, sealed through `SecretBox`. Signature is checked before any claim is trusted. Comparison is constant-time.
10. **Key failure fails closed.** No key, or a key that cannot be opened, is refused. The issuer throws `signing_key_missing`, which the handler maps to 503.
11. **Tokens last 900 seconds** for the session endpoint. The issuer caps any TTL at 3600 seconds.
12. **Verifier checks trust again** on every request, so removing an origin from the list revokes existing tokens at once.
13. **Session token is in memory only** in the browser. It is not written to localStorage.
14. **Only the visitor id is stored in localStorage.** It is random, 22 characters, and carries no personal data.
15. **Message endpoint needs `Authorization: Bearer`.** Message text is trimmed and limited to 2000 characters.
16. **Message port is injected.** The widget does not call the conversation runtime itself. The owner wires `WidgetMessagePort` to the runtime.
17. **Rate limits** are fixed windows per endpoint, keyed by client IP and public id, applied before any storage lookup. The limit values are set by the owner when wiring.
18. **Rate limiter holds counts in process memory.** With several server processes, each counts alone. A shared store is needed before scaling out.
19. **Tenancy exception: public-id lookup.** `selectChatbotByPublicIdQuery` is not scoped by company, because the public id is the only tenant key a visitor can send. It is safe because the id is a random UUID, and every later query is scoped by the company it returns. Recorded in `storage.ts`.
20. **Unique constraint includes company_id.** `widget_chatbot_configs` is unique on `(company_id, public_id)`, per the convention. Global uniqueness of `public_id` rests on random generation, not on the database.
21. **No foreign key to chatbots.** `chatbot_id` is a plain uuid, so the table can be promoted before the chatbots table is final.
22. **Widget tables duplicate the public fields** of the chatbot. The owner decides later whether to read `chatbots` directly.
23. **No inline script.** The widget loads as a normal `<script src>`, reads `data-chatbot-id`, and takes its origin from its own src. The legacy embed built inline `onload` handlers from server values. That is not ported.
24. **No innerHTML.** Every server or visitor string goes through `textContent`. A test scans the source to enforce this.
25. **Styles are written fresh** and kept inside one injected `<style>` element. Layout and colour roles follow the core widget. No rule is copied.
26. **No framework in the browser widget.** Plain TypeScript, so it can be bundled as one small file without touching the app's build.
27. **Preflight echoes only a trusted origin.** Never `*`. Config and session responses set `Vary: Origin`.
28. **Session endpoint uses the request Origin and the visitor id from the body.** The visitor id must match `[A-Za-z0-9_-]{16,64}`.
29. **Browser calls carry no cookies** (`credentials: "omit"`), and every call has an 8-second timeout.
30. **Trusted-domain normalisation** accepts `https://` prefixes and trailing slashes, as the legacy request did, and drops invalid entries.

## Not done here (owner's steps)

- Express adapter and route mounting. The handlers take plain request objects.
- Wiring `WidgetMessagePort` to the conversation runtime.
- Client IP resolution behind a proxy. The adapter supplies `ip`.
- Build entry for `client/src/widget/index.ts` in the app's bundler.
- Renumbering migration `0201_widget.sql`.
- Shared rate-limit store for more than one process.

## Completion pass (2026-11-09)

Files added or changed: `proxy.ts`, `rate-limit-store.ts`, `stream.ts`, `reply-port.ts`, `express.ts` (new); `handlers.ts`, `index.ts` (changed); `client/src/widget/sync.ts` (new); `client/src/widget/api.ts`, `client/src/widget/widget.ts` (changed). Tests: `tests/modules/chatbot-widget-public.test.mjs`.

### Decisions that change behaviour

1. **Two rate-limit layers.** The per-process limiter still runs before any storage lookup, as before (the existing test pins this). The shared store runs after the tenant is known, keyed by company. Both must allow a request.
2. **Shared store is behind `RateLimitStore`.** Memory and Drizzle implementations share one window rule (`decideWindow`). The Drizzle store is a single atomic upsert on `(company_id, bucket_key)`.
3. **Shared store refuses bad input.** A missing or malformed company throws before any query. An empty or over-255-character key is refused without a query.
4. **Trusted proxies come from configuration only.** `parseTrustedProxies` accepts exact addresses and CIDR blocks, IPv4 and IPv6. `*` and `/0` are rejected. Invalid entries are dropped, so they are not trusted.
5. **Forwarded address is read only from a trusted peer.** The chain is walked from the right. The first untrusted hop is the client. A malformed chain, or more than 16 hops, falls back to the peer.
6. **No peer address means the shared bucket `unknown`.** This is a refusal path, not a bypass.
7. **Message endpoint checks the token before the shared limit.** The company is then known from the verified claims.
8. **Origin is refused before the body is read.** A missing Origin, or one not trusted for the chatbot, gets 403 from the verifier.
9. **Two new read endpoints need a Bearer token.** `messages` (polling, `?after=` cursor, oldest first) and `stream` (server-sent events). Both return only public fields: `id`, `role` (assistant or staff), `text`, `createdAt`.
10. **Token check returns expiry and scope only.** It never returns company or visitor claims.
11. **Stream frames are fixed.** `id`, `event: message`, one JSON `data` line. Heartbeat every 25 seconds. Headers are `no-store` and `X-Accel-Buffering: no`. The subscription is removed when the client closes.
12. **Reply runtime is an adapter.** `createReplyRuntimeMessagePort` takes a `WidgetReplyRuntime` and keeps only `id` and `text` from its result. A bad result is a 503 with a generic body.
13. **Realtime is coded against an interface.** `server/modules/chatbot/realtime/` does not exist yet. `WidgetMessageFeed.subscribe` is the seam. The feed's storage (reading replies, subscribing to new ones) is not written here.
14. **Browser sync prefers the stream.** It uses fetch, not EventSource, so the Bearer header can be sent. A 404, 405 or 501 on the stream switches to polling for the session. Other failures reconnect with a backoff of up to 60 seconds, with one poll after each drop.
15. **Sync starts after the first successful send.** A page view alone opens no session and no stream.
16. **Each reply is shown once.** The widget keeps a set of shown ids, and the sync keeps its own set of 500 ids.
17. **Bundle entry is unchanged.** `client/src/widget/index.ts` remains the one script. No build step is added. The bundle build stays the owner's step.
18. **Express factories import no express.** Types are structural. Nothing is mounted.

### Change requests (owner or contracts agent)

- Move `widgetRateLimits` from `widget/rate-limit-store.ts` into `db/widget.ts`, to follow the rule that tables live in `db/<area>.ts`. This was not done because `db/` is outside this area.
- Write a draft migration for `widget_rate_limits` (primary key `(company_id, bucket_key)`, `window_start_ms bigint`, `hits integer`, index on `company_id`). This was not done because `db/migrations-draft/` is outside this area.
- Confirm the realtime stream contract. `WidgetMessageFeed` is the interface to match.
- Wire `WidgetReplyRuntime` to the conversation and message runtimes, and implement `WidgetMessageFeed` over the messages table.

### Still open

- Old rows in `widget_rate_limits` are never deleted. A periodic cleanup is needed.
- The SQL upsert is tested against a fake database that applies the same window rule. It has not been run on Postgres. The harness script `db/harness/pg-local.sh` exists, but `apply-drafts.mjs` does not.
