# AgentLabs references inventory (issue #54)

Scope: `client/`, `server/`, `shared/` (excluding `node_modules`). Recorded on 2026-11-18 from `grep -rniI 'agent[ _-]?labs'`.
Total matches: 29 lines in about 20 files. No user-visible JSX or UI string still says AgentLabs.

## Kept on purpose (compatibility identifiers, do not rename without a migration)

| Location | Identifier | Why it stays |
|---|---|---|
| `client/src/components/BrandingProvider.tsx:55` | localStorage key `agentlabs-branding:v3` | Cached branding; `client/index.html:37` reads the same key inline before the app boots. Both must change together. |
| `client/src/components/CookieConsentBanner.tsx:31` | storage key `agentlabs_cookie_consent` | Existing visitors' consent records. |
| `client/src/components/AnalyticsScripts.tsx:27` | storage key `agentlabs_hidden_analytics_scripts` | Existing user preference. |
| `client/src/components/AnalyticsScripts.tsx:33` | selector `[id^="agentlabs-"]` | Hides legacy widget elements still emitted by old plugins. |
| `client/src/contexts/plugin-registry.tsx:212-224` | `window.__AGENTLABS_PLUGIN_REGISTRY__` | Plugin bundles call this global. Also named in `client/src/components/plugin-bootstrapper.tsx:12`. |
| `client/src/hooks/use-toast.ts:205` | `window.__AGENTLABS_TOAST__` | Global used by external plugin bundles. |
| `client/src/main.tsx:30` | `window.__AGENTLABS_REACT_I18NEXT__` | Global used by plugin bundles. |
| `server/services/rag-elevenlabs-tool.ts:65` | HMAC salt `agentlabs:rag-webhook-secret:v1` | Changing it invalidates issued webhook secrets. |
| `server/services/form-elevenlabs-tool.ts:42` | HMAC salt `agentlabs:form-webhook-secret:v1` | Same as above. |
| `server/integrations/titan-workforce/lead-review.mjs:40,51,52,59,64` | schema `agentlabs-lead-intent.v1`, `titan.agentlabs.lead-transition-preview.v1`, provenance `producer`/`source` `agentlabs`, evidence ref `agentlabs:review:` | Stored provenance and schema contract. |
| `server/integrations/titan-workforce/proposal.mjs:31` | `source:'agentlabs'` | Stored provenance value. |
| `server/plugins/loader.ts:46` | manifest field `compatibility.agentlabs` | Plugin manifest contract field. |
| `server/routes/plugin-routes.ts:297-298` | replaces legacy literal `AgentLabs` with the configured `app_name` | Runtime rebrand for old plugin HTML; it is the fix, not a leak. |

## Attribution (legally required, keep)

| Location | Text | Why |
|---|---|---|
| `server/middleware/correlation-id.ts:3` | `@copyright Diploy - AgentLabs` | Donor copyright notice for code that came from the AgentLabs base. |
| Header comments in `client/src/App.tsx`, `CreditWidget.tsx`, `ScrollToTop.tsx`, `AnalyticsScripts.tsx`, `DirectionProvider.tsx` and similar | `Website: https://diploy.in`, `Contact: cs@diploy.in` | Upstream attribution headers. Not AgentLabs text, listed for completeness. |

## Reworded in this PR (comments only, no behaviour change)

| Location | Before | After |
|---|---|---|
| `server/utils/logger.ts:14` | Professional logging utility for AgentLabs platform | ... for the Supercharged platform |
| `server/integrations/titan-workforce/route.mjs:1` | Admin authentication is supplied by AgentLabs. | ... supplied by the host platform. |
| `server/integrations/titan-workforce/lead-review.mjs:1` | Native AgentLabs adapter | Native host-platform adapter |
| `server/integrations/titan-workforce/lead-review.mjs:68` | Native AgentLabs Express route | Native Express route |
| `client/src/components/AnalyticsScripts.tsx:33` | Any AgentLabs prefixed elements | Legacy elements with the agentlabs- prefix |

## Still open for #54 (not done in this PR)

1. Audit the surfaces named in the issue (emails, notifications, PWA manifest, public pages, help, demos). This PR only checked source text. Server-side email templates and seeded DB rows (`global_settings.app_name`, branding defaults) were not inspected.
2. Canonical source tree decision: which of the duplicate or donor trees (`source/`, `vendor/`, `packages/`, `plugins/`, `_TITAN_HANDOFF/`) is authoritative. Needs an owner decision.
3. Any rename of the compatibility identifiers above needs a migration plan, which is not part of this change.
