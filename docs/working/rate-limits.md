# Rate limits on auth and public routes

Runbook for the general per-IP limit in `server/middleware/public-route-rate-limit.ts`.
The per-route limiters in `server/middleware/rateLimiter.ts` and the per-account
webhook limiter in `server/middleware/provider-webhook-rate-limit.ts` are unchanged.

## What is limited

| Bucket | Default | Paths |
| --- | --- | --- |
| auth | 10 per minute per IP | `/api/auth/login`, `/api/auth/register`, `/api/auth/send-otp`, `/api/auth/verify-otp`, `/api/auth/change-password`, anything under `/api/auth/forgot-password` and `/api/auth/magic-link` |
| public | 60 per minute per IP | `/api/branding`, `/api/contact`, `/api/public/*`, `/api/settings/public`, `/api/system/version`, `/api/twilio-countries` |

A refused request gets HTTP 429, a `Retry-After` header in seconds, and a JSON body `{ "error": "..." }`.

## Exempt paths (never counted)

- **Provider webhooks**: any path with a `webhook` or `webhooks` segment. Providers (Twilio, Stripe, PayPal, Razorpay, Paystack, Mercado Pago, ElevenLabs, chatbot channels) call from a small set of shared IPs for many tenants, so a per-IP cap would drop real events. They keep their own limits.
- **`/api/health`**: monitors and load balancers poll it from one address.

Other `/api/*` paths are not limited here. A per-IP cap on all of `/api` would
hit offices and NAT networks where many signed-in users share one address.

## Settings (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_ENABLED` | on | `false` or `0` turns the whole limiter off |
| `RATE_LIMIT_AUTH_MAX` | 10 | requests per window on auth paths |
| `RATE_LIMIT_AUTH_WINDOW_MS` | 60000 | auth window length |
| `RATE_LIMIT_PUBLIC_MAX` | 60 | requests per window on public paths |
| `RATE_LIMIT_PUBLIC_WINDOW_MS` | 60000 | public window length |
| `RATE_LIMIT_MAX_BUCKETS` | 10000 | counters kept in memory; when full, new clients get 429 until a window expires |

Invalid values are logged and the default is used.

## Client IP and `TRUST_PROXY`

The limiter keys on `req.ip`. Express only sets `req.ip` from `X-Forwarded-For`
when `TRUST_PROXY` names the proxy in front of the app. With it unset, the key
is the socket address, so a client cannot choose its own bucket by sending
`X-Forwarded-For`.

Behind a reverse proxy, set `TRUST_PROXY` to match that proxy:

- a hop count, for example `1` when one proxy sits in front of the app;
- or a list of proxy addresses or ranges, for example `10.0.0.5` or `10.0.0.0/8,127.0.0.1`;
- or `loopback`, `linklocal` or `uniquelocal`.

Never set `TRUST_PROXY=true`. The app refuses it and falls back to `false`.
See `server/middleware/trust-proxy.ts` and `docs/proxy/desk-modes.nginx.conf`.

If the app is behind a proxy and `TRUST_PROXY` is unset, every user shares the
proxy's address as one bucket. The limit then trips far too early. Check this first
when users report 429 on login.

## Known limits

- Counters are in memory, per process. With several app processes each one counts separately.
- Requests whose IP cannot be read share one `unknown` bucket.
- No `magic-link` route exists in the code today. The prefix is reserved so a future route is covered.
