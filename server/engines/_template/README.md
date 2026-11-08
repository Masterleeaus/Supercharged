# Engine template

An engine is a group of providers that share one set of types, one audit path and one webhook
helper. Each provider is a folder under `gateways/` with the same four files. Stripe, Razorpay and
the other payment gateways follow this layout, and so does the KYC engine.

## Layout

| Path | Role |
| --- | --- |
| `index.ts` | Public exports and `register<Engine>Engine(router, requireAuth, requireAdmin)`. Returns early when the flag is off. |
| `config.ts` | Engine name, version, provider id, and `isEngineEnabled()`. |
| `types.ts` | `GatewayAdapter` (`create`, `verify`, `handleWebhook`), `ProviderStatus`, request and result types. |
| `registry.ts` | `registerGateway`, `getGateway`, `listGateways`. |
| `audit.ts` | `auditEngineEvent`. Wraps `logAuditEvent` in `server/services/audit-log.ts`. |
| `webhook-helper.ts` | `verifyWebhookSignature` (placeholder, fails closed), `hmacSha256Hex`, `safeEqual`. |
| `gateways/<provider>/` | One provider. The template ships a skeleton named `_provider` with `index.ts`, `handlers.ts`, `service.ts`, `routes.ts`. |
| `VERSION`, `CHANGELOG.md` | Semver version of the engine and its history. |

## Feature flag

The engine and every provider in it are off by default. Routes mount only when the environment
variable `TITAN_ENGINE_<NAME>_ENABLED` is exactly `true`. Any other value, including `1`, `TRUE`
or an empty string, leaves the engine off. `<NAME>` is the engine name in upper case with `-`
replaced by `_`. The flag is read at call time.

## Create a new engine

Use the generator. It copies this folder, renames the provider folder, replaces the name tokens,
and writes `VERSION`. It refuses to overwrite an existing engine and deletes its output if any
token is left behind.

    node scripts/new-engine.mjs <engine-name> <provider-name> [--version 0.1.0]

Example: `node scripts/new-engine.mjs billing stripe` creates `server/engines/billing/` with a
`gateways/stripe/` provider and the flag `TITAN_ENGINE_BILLING_ENABLED`.

To test without touching the repo, pass `--root <dir>` where `<dir>` contains
`server/engines/_template`.

## Add a provider to an existing engine

1. Copy the `_provider` skeleton folder under `gateways/` to `gateways/<provider>/`.
2. In the four copied files, replace the provider name tokens with the provider's lower-case name
   and PascalCase name. The generator script lists them.
3. In the engine's `index.ts`, point the `registerProviderRoutes` import at the new folder.
   Mount each provider from `register<Engine>Engine`, after its guard.
4. Implement `service.ts` (API calls), `handlers.ts` (webhook events, after the signature check),
   and `verifyWebhookSignature` in `webhook-helper.ts` for this provider's scheme.
5. Add a `CHANGELOG.md` entry and bump `VERSION`.

## Mount the engine

Call it where the other engines are mounted, in `server/routes.ts`, using the same middleware cast
as the KYC call:

    register<Engine>Engine(app, authenticateToken as any, checkAdmin as any);

Do this only after the engine has been reviewed. The template itself does not change `server/routes.ts`.

## Rules for providers

- **Fail closed.** A webhook with no verified signature is rejected before any parsing or dispatch.
  `verifyWebhookSignature` returns `valid: false` until a provider implements it.
- **Raw body.** Signatures are computed over the exact bytes received. The webhook route uses
  `express.raw`. If an earlier middleware already parsed the body, the route cannot verify it. Mount
  the webhook before any global JSON parser, or exclude this path from it.
- **Constant-time compare.** Use `safeEqual`, not `===`.
- **Audit.** Use an existing `AuditAction` from `server/services/audit-log.ts`. A new action means
  adding it to that union, as a separate change.
- **Amounts.** Integers in minor units. Currency is ISO 4217 upper case.
