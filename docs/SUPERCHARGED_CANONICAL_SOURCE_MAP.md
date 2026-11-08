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
| Other root files | 28 | Root configs/docs/lockfile and entry scripts. |

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

## Pass 4 — bootstrap identity and additional UI audit

- Reconciled default branch before edits: no newer commits behind at start of pass.
- `client/index.html` previously loaded `agentlabs-branding:v1`, while the active `BrandingProvider` writes `agentlabs-branding:v3`. The HTML now reads only the active key, applies the same 24-hour TTL, and refuses invalid/future timestamps. Historical key names are retained to avoid a storage migration without tests.
- `BrandingProvider` now rejects invalid/future timestamps rather than accepting them indefinitely.
- `LoginPage.tsx` no longer labels the demo iframe as AgentLabs; the accessible title uses the active configured app name, falling back to Supercharged.
- The hard-coded demo account (`demo@diploy.in`) is **not** rebranded: those strings may be credential identifiers. Whether demo mode should be shipped at all is a separate security/product decision; no credentials were changed.
- Original Diploy legal notices in source remain untouched as required by issue #37.
- No first-party install manifest file was present in the full main tree listing. The chatbot PWA asset folder is present, but no installability or separate bundle behavior was verified.
- Added `tests/branding/supercharged-brand-cache.test.mjs`: exercises the actual HTML bootstrap using Node's VM, checks stale/malformed/future cached data, configured tenant identity, matching provider TTL logic, and public API source defaults. Not run in a checkout this pass.

### Pending to finish #54
Inventory remaining localized strings, application-controlled default `app_name` records, public notifications/emails, service-worker/PWA release packaging and actual deploy configuration. Complete donor dependency graph and rights review before removing generated/donor code. Run Node tests, typecheck and build; no production readiness claim.

## Pass 5 — email, notification, locale and public PWA follow-up

- Audited `server/services/email-service.ts`, `server/services/notification-service.ts`, `server/seed-email-templates.ts`, `plugins/messaging/services/email-template.service.ts`, English localization, active login and landing navigation, and the chatbot PWA folder.
- The email service previously defaulted `appName` to an empty string. Its product fallback is now `Supercharged`; a configured `app_name` and configured SMTP sender name still take precedence. The default tagline was changed to `Business communications and operations`.
- Seeded welcome emails (HTML and plaintext) now describe customer communication capabilities without referring to the old bulk-calling-only product identity. The HTML header uses the neutral descriptor while preserving the `{{companyName}}` placeholder, its subject, and all template variables.
- Initial global settings seeds use the same neutral descriptor in `company_tagline`. Existing stored settings are not force-updated.
- Notification service and English locale had no literal legacy AgentLabs brand name in the inspected source. Other languages and generated assets have not yet been individually reviewed.
- The `plugins/messaging/services/email-template.service.ts` comment explicitly labels the optional AgentLabs compatibility shim. No rename was made: the shim is a compatibility boundary, not a consumer-facing title.
- `LoginPage.tsx` still contains the inherited `demo@diploy.in` credentials in its optional demo mode. Those are identity-sensitive and were deliberately left unchanged pending a test-auth review.
- Added `tests/branding/supercharged-email-defaults.test.mjs` with three regression checks for fallback identity, seeded tagline consistency, configured sender precedence and the tenant-name placeholder.
- CI on the previous pass reported 5,944 passed / 3 failed (13 skipped) and a successful production build; the six browser-branding regression tests passed. Failures are in workforce registration/schema/timeout tests, with separate migration and informational typecheck failures. The Pass 5 tests are newly committed and still require CI execution.

**Still open:** remaining locale files, actual rendered email flows, notifications, full install/PWA provenance and donor comparison. Tests and build must be verified for the current PR head before merging.

## Pass 6 — notification defaults, all locales and CI verification

- Inspected the active `NotificationService` and the UI notification components (bell, banners, administrator broadcast), plus the chatbot events notification adapter. None of their inspected text contains a former first-party product label outside retained Diploy copyright notices.
- The actual notification service's `DEFAULT_APP_NAME` was still an empty string. It now falls back to `Supercharged`, treating blank or whitespace-only stored names as unset. Nonblank configured names take precedence.
- Parsed each of the **12 locale JSON files** (English plus Arabic, German, Spanish, French, Hindi, Italian, Japanese, Polish, Portuguese, Russian and Swedish) successfully. A case-insensitive literal search found no `AgentLabs`, `Agent Labs` or `Diploy` names in those translation files. This does **not** mean that every translated marketing claim has been updated.
- Inspected `client/public/chatbot-pwa/NOTICE.md` and two Titan Train app manifests: the PWA assets are sourced from a Clean-Hub donor, with explicit provenance restrictions. Do not rewrite/remove this NOTICE or declare this a Supercharged installable PWA without verifying the real deployment/manifest pipeline.
- Added `tests/branding/supercharged-notifications-and-locales.test.mjs` to enforce the notification default and English/11 other locale JSON identity checks.
- **Verified GitHub Actions on pass-5 head**: production build succeeded; 5,947 tests passed, three failed (13 skipped); the six bootstrap and three email branding tests passed. The same three workforce suite failures remained, plus failing migration inventory and informational typecheck. Pass-6 tests still require a completed CI check.

No merge, deletion, tenant data migration, privilege change, template schema change or third-party attribution removal was performed.

## Pass 7 — live tenant branding and SEO accuracy

- Verified completed pass-6 CI: all 11 added branding tests passed; overall suite **5,949 passed / 3 failed / 13 skipped**. Production build passed, while informational typecheck, migration inventory and three known workforce tests remained failing.
- `BrandingProvider.getBrandingSignature` omitted `app_tagline` and three social URLs, even though the provider compares signatures to decide whether to apply/cache new server data. These keys are now included so edits to those settings refresh live branding without requiring unrelated changes.
- `BrandingProvider.readCache` now rejects invalid cache structures without a `data` object or string `app_name`. This protects reloads against malformed storage.
- Favicon effect now restores the default `/favicon.png` when the configured business favicon is removed. Previously the old customer favicon could persist in the open browser tab.
- `LandingPage` now uses `branding.app_name` for the fallback SEO title, keeping company-configured names instead of stamping Supercharged onto white-labelled sites. The fallback SEO description is a neutral communications/operations description.
- Seeded social/site/homepage SEO descriptions and pricing copy no longer promise a free trial, free credits, or capabilities not checked against the actual package. These changes affect new defaults, not existing administrator-controlled SEO records.
- Added `tests/branding/supercharged-provider-and-seo.test.mjs` (4 checks) to exercise the actual brand signature implementation, verify favicon reset, reject invalid cached payloads and protect tenant-aware metadata. The test extraction supports CRLF in the source file.
- None of these changes alters authentication identifiers, customer branding values, data migration, licensing notices, PWA donor files or existing server persistence.

**Open:** verify current-head CI and runtime cross-company isolation, complete canonical source merge and legal license review; issue #54 and its draft PR must remain open.
