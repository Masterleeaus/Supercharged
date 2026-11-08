# Supercharged canonical source map — issue #54 (initial audit)

> Status: **partial inventory, not a declaration of full integration or production readiness**. Based on source files inspected on 2026-11-09; a complete recursive source-tree audit and runtime tests remain outstanding.

## Canonical entry points currently identified

| Area | Observed path | Status / boundary |
| --- | --- | --- |
| Browser shell | `client/index.html` | Active Vite HTML entry; now defaults to Supercharged title/description. |
| Client application | `client/src/App.tsx` | Active React router, includes legacy modules and feature-gated routes. |
| Client branding | `client/src/components/BrandingProvider.tsx` | API-controlled business branding and cached settings; Supercharged is the default when no name is configured. |
| Marketing homepage | `client/src/pages/LandingPage.tsx` | Uses SEO API override; default fallback now names Supercharged. |
| Legacy login | `client/src/pages/Login.tsx` | Still maintained in source; legacy 'AL' monogram replaced with an 'S'. |
| Primary login | `client/src/pages/LoginPage.tsx` | Uses BrandingProvider. Still requires full surface and localization audit. |
| Desk modes | `client/src/components/cockpit/desk-mode.ts` | Existing host-derived workforce/syncedat modes; future Marketing/Inbox redesign is issue #52, not complete here. |
| HTTP/API server | `server/index.ts`, `server/routes.ts` | Root scripts indicate active server entry and central route registration; do not declare every module live. |
| Workforce | `server/workforce/` | Dedicated agent/course implementation, subject to runtime and registration gates. |
| Communications/modules | `server/modules/` | Mixed mounted, gated, draft and unmounted modules. See STATUS.md for currently documented distinctions. |
| Shared models | `shared/schema.ts` | Drizzle schema, requiring Central company_id reconciliation (#51). |
| Schema/migrations | `migrations/`, `scripts/run-safe-migration.mjs` | **Not safe to certify for production** until #34 and #51 are resolved. |
| Build | `package.json` | Vite client and esbuild server; `agentlabs` package identifier intentionally retained pending lockfile/dependency migration and #35. |

## Guardrails

- Preserve inherited third-party copyright and license notices, original author attribution, provider names and compatibility-sensitive internal identifiers.
- Preserve customer-supplied branding returned from `/api/branding`. A configured tenant or business name must not be overwritten by the fallback product identity.
- Treat `agentlabs-branding:v1` and `agentlabs-branding:v3` as storage compatibility keys, not customer-facing brand strings. Migrate only with fallback/cleanup tests.
- Do not delete an apparent duplicate or donor implementation without a complete import graph, provenance review and tests.
- Keep Synced chatbot builder (#48), named Managers (#49–50), mode changes (#52), and Central identity (#53) as explicit separate workstreams.
- Do not claim routes, migrations, workers or provider integrations are live unless end-to-end verified.

## Known follow-ups for #54

1. Complete recursive inventory of active, donor, generated, archive and duplicate trees, including all import references.
2. Review login, onboarding, sidebar, settings, notifications, emails, PWA metadata, public pages, help, demos and locale keys for stale product naming.
3. Review server defaults that populate `/api/branding`: a legacy server-provided app name can still override the new client fallback.
4. Audit build/runtime entry points and installation guidance, with #35 and #34.
5. Run `npm ci`, typecheck, automated tests and production build in a network-enabled checkout; unavailable during this pass. Keep the issue open until verified.

## This pass

Changed only four targeted client files to establish product-level defaults. No database migration, API permission, provider, license or company identity behavior was intentionally modified.
