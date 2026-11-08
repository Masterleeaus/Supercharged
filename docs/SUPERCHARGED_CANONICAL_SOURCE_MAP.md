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


## Recursive GitHub tree inventory — 2026-11-09

The GitHub Git Trees API was queried for `main?recursive=1`. GitHub returned `truncated: false`, with **3,003 total tree entries**, of which **2,612 are blobs/files**. These figures are for the main branch at the time of the query, not a full textual analysis of every file.

| Top-level grouping | Tracked blobs | Interpretation |
| --- | ---: | --- |
| `server/` | 1,225 | Active server and embedded engines/workforce. Needs import-graph audit. |
| `client/` | 356 | React browser application, public assets, chatbot UI and locale resources. |
| `tests/` | 376 | Repository test assets; not all tests necessarily run via the root script. |
| `_TITAN_HANDOFF/` | 372 | Explicit donor/handoff/source-manifest collection. Treat as provenance material until compared, not removable duplicates. |
| `vendor/` | 66 | Third-party or imported vendor content; inspect licensing and references first. |
| `dist/` | 45 | Checked-in build output/assets; do not delete until deployment requirements and references are verified. |
| `docs/` | 45 | Documentation including pending design/patch material. |
| `migrations/` | 44 | SQL and migration metadata; requires strict coordination with Central (#51) and runner repair (#34). |
| `scripts/` | 36 | Build, migration, admin/deployment support scripts. |
| `plugins/` | 10 | Workspace plugin adapters including comms, messaging, workforce bridge/runtime. |
| `packages/` | 8 | Local packages including diploy-core (internal compatibility identity; do not mechanically rename). |
| `shared/` | 1 | Shared Drizzle models. |
| Other root files | 24 | Root configs/docs/lockfile and entry scripts. |

The groups sum to **2,612**. Counts are tracked files, not lines of code or proven duplicate implementations.

### Specific duplication/provenance candidates

- `_TITAN_HANDOFF/FIELD_DONORS_FOR_ADAPTATION/` contains an independent `apps/web` and `services/worker` donor layout. It is not the root application's build entry.
- `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/` contains another independent packages/services source lineage and several cumulative manifests; verify unique algorithms and licensing before consolidating.
- `dist/public/` overlaps the role of `client/public/` as published assets, but could be required by deployment as presently configured.
- `client/src/pages/Login.tsx` and `client/src/pages/LoginPage.tsx` are distinct login implementations; determine routing and active audience before merging.
- `client/public/chatbot-pwa/` is a separate deployable surface; verify whether it is active and what owns its build/install path.
- `migrations/archive/` and `docs/pending/` are archival/draft in naming, but no deletion is authorised without an import/dependency check.

### Branding findings and changes from the second pass

- `client/src/components/landing/SEOHead.tsx` used the generic `AI Platform` Open Graph fallback. It now defaults to Supercharged when no specific organisation/site name is supplied.
- `server/seed-seo-settings.ts` included generic AI calling platform defaults for site, Open Graph, Twitter and homepage titles. New seed defaults now carry the Supercharged product name; already-saved administrator values must remain authoritative.
- The SEO seed's example canonical domain referenced a legacy AgentLabs address. Its explanatory example is now a neutral `example.com` URL; configured domains are unchanged.
- Original Diploy/Envato copyright notices are maintained unchanged, pending the distinct rights reconciliation tracked by #37.

**Execution limitations:** The connected GitHub API allowed exact tree enumeration and source reads/writes, but there was no network-enabled local checkout or installed dependencies in this pass. No claim is made that compilation, tests, integration behavior or production deployment passed.
