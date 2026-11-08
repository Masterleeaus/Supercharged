# __ENGINE_PASCAL__ Engine Changelog

All notable changes to this engine are recorded here. The first entry is the template.

## [0.1.0] - Template

### Added
- Engine skeleton: `index.ts`, `config.ts`, `types.ts`, `registry.ts`, `audit.ts`, `webhook-helper.ts`
- `GatewayAdapter` contract: `create`, `verify`, `handleWebhook`, and the `ProviderStatus` type
- `auditEngineEvent`, a wrapper over the shared `logAuditEvent`
- `verifyWebhookSignature`, a placeholder that fails closed, plus `hmacSha256Hex` and `safeEqual`
- One provider skeleton under `gateways/__PROVIDER_NAME__/`
- Engine flag `TITAN_ENGINE___ENGINE_ENV___ENABLED`, off unless set to `true`

### Update instructions
1. Keep the engine folder under version control. Changes to shared types are breaking.
2. Bump `VERSION` and `ENGINE_VERSION` together.
3. Add an entry here before merging.
