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

## Pass 8 — installer-to-branding continuity

- Confirmed GitHub Actions result for the Pass 7 PR head: **production build succeeded**, **5,953 tests passed, three failed, 13 skipped**, and all 15 branding regression tests succeeded. The three unrelated workforce test failures, migration inventory failure and informational typecheck failure persist.
- Inspected `client/src/pages/InstallWizard.tsx`, `server/routes/public-routes.ts` and the app's brand provider. The installer collects `companyName`, but previously persisted only `company_name`; downstream public React and email identity read `app_name`, creating a newly installed company's name mismatch.
- The fresh-install settings list now writes `app_name = companyName` **as well as** `company_name = companyName`. This occurs only inside the existing initial installer path and does not change saved branding for existing installations, schema, authentication or public API routes.
- Added `tests/branding/supercharged-installer-identity.test.mjs` with three regression assertions verifying installer payload and both persistence keys, and the priority of stored company branding over product defaults.
- No standalone web-app install manifest or service worker was identified in the tracked active client/public root by the recursive tree scan. The `chatbot-pwa` folder is a separately sourced donor with a NOTICE and is intentionally not renamed to imply an installable Supercharged PWA.
- Plugin installer and plugin manifest are separate capabilities (ZIP plugins, not browser installability). Their schema, compatibility keys and notices were not changed.

**Outstanding:** CI verification of the three new installer assertions and new-build artifact, further actual install/runtime testing, all user-facing surfaces and donor code/license reconciliation; draft PR remains open.

## Pass 9 — admin/public branding consistency and caching

- Verified CI on completed Pass 8 head: production build **passed**; 5,956 tests **passed**, three failed, 13 skipped. All 18 brand regression tests passed; the three failing tests remain in workforce read-tool composition and declared tool metadata. Migration inventory and informational typecheck remain failing.
- Audited the two distinct branding GET handlers: `/api/branding` and `/api/admin/branding`. Public API already provided a product fallback, but a legacy stored blank name could overwrite it. Admin API initialized to an empty object, so an unconfigured installation could present an empty name in admin settings.
- Public GET now ignores stored blank/whitespace/non-string `app_name` values while retaining real configured values. Admin GET now supplies `app_name: Supercharged` and an empty tagline as defaults and applies the same blank-name protection; settings edits and custom tenant names remain authoritative.
- Public GET's response previously had `Cache-Control: public, max-age=300`; admin changes might remain invisible through browser caches despite React query invalidation. Only the branding GET response was changed to `Cache-Control: no-store`, leaving unrelated caching policies untouched.
- Added `tests/branding/supercharged-branding-api-defaults.test.mjs`: four source-level contract tests, including cache-header protection, fallback precedence, admin branding query binding, and user-set names. These need execution on the Pass 9 head.
- No third-party notices, historical cache keys, datastore records, donor code or deployment artifacts were modified.

**Not yet production-ready:** runtime tenant isolation, entitlement and installation verification, legal ownership review, migration baseline repair and source consolidation still pending.

## Pass 10 — user-facing root identity, canonical duplicate verification

- Verified Pass 9's completed GitHub Actions: production build passed, 5,960 tests passed / 3 failed / 13 skipped, and all 22 branding tests passed. The same workforce tool composition, explicit schema and timeout tests remain failing; migration inventory and informational typecheck are red.
- Corrected the live administrator branding editor's `placeholder="AgentLabs"` to `Supercharged`. The form still persists customer-chosen app names.
- Changed product-oriented headings, marketing overview and selected prose in root `README.md` and `INSTALLATION.md` to Supercharged. Flagged inherited capabilities and release examples as **unverified**, preserving compatibility-sensitive PM2 names, archive paths and DB names; no license notices removed.
- Added `tests/branding/supercharged-product-docs.test.mjs` with three regression checks for the admin form, new product identity, inherited capability caveats and historical deployment examples.
- Performed exact Git blob SHA comparison on the complete 3,003-entry / 2,612-file main-tree snapshot: **2,536 unique blobs, 64 duplicate SHA groups (140 file path slots), including 25 active/donor groups, 35 active/dist groups and four other groups**.
- Saved the complete 64-group paths/hash-prefix inventory to `docs/SUPERCHARGED_BLOB_DUPLICATION_AUDIT.md`, including exact revenue journey and field-link runtime authority donor twins. Directory-based `active` classification is *not* evidence a path is loaded. No destructive deduplication: determine imports, ownership, licenses and unique divergent features first.
- The three new document/branding regression tests are pending GitHub Actions on this pass. The audit does not establish production readiness or installable PWA capabilities.

**Remaining:** import/loader analysis, separate semantic comparison of divergent copies, licensing approval, remaining UI/help/demos and production execution validation, CI baseline repair. PR draft; issue #54 open.

## Pass 11 — reusable source ownership audit

- Verified completed Pass 10 CI: **5,963 passed / 3 failed / 13 skipped**, all 25 new brand tests passed, and production Build succeeded. Migration inventory and informational typecheck failed, with the same three workforce tool assertions failing.
- Introduced `scripts/audit-source-duplicates.mjs`, a reusable, read-only SHA-256 working-tree scanner. It reports per-file exact duplicate groups and active/donor/generated buckets. Historical Git blob snapshot counts are not assumed to equal on-disk SHA-256 counts when a checkout contains other files.
- Added `tests/infrastructure/source-duplicate-audit.test.mjs` covering true byte equality, divergent same-name files, source category classification, ignored temporary/installed dirs, and symbolic-link non-traversal. The four tests are newly committed and await CI.
- Identified local sibling imports in `server/integrations/titan-revenue` and `server/integrations/field-link/vendor/authority`; this grounds component boundaries but does not establish whether server route wiring activates these modules.
- Reviewed `server/integrations/field-link/vendor/NOTICE.md` and `server/integrations/field-link/client.ts`: vendored Field runtime is marked as upstream-owned, lacking verified license permissions, and actual Field endpoints are assumed, not proven live. Do not edit/delete vendor twins or claim live Field integration.
- Found root package `license: MIT` while original source headers and license documentation reference Envato/CodeCanyon. Treat as unresolved legal provenance, not a grant of distribution rights. Preserve both pending issue #37.
- Detailed the scanner CLI and inspected import/provenance observations in `docs/SUPERCHARGED_BLOB_DUPLICATION_AUDIT.md`.

**Incomplete:** verified import graph for the rest of the repository, divergent donor merge, runtime integration verification, legal reconciliation, failing existing CI tasks. PR draft; issue #54 open.

## Pass 12 — build-aware import ownership groundwork

- Confirmed Pass 11 CI on GitHub: production build passed; **5,967 passed / 3 failed / 13 skipped**, including all four new source-duplication audit tests. Persistent failed tests remain workforce composition/schema/timeout; migration inventory and informational typecheck separately failed.
- Added `scripts/audit-import-ownership.mjs`, a read-only working-tree parser for static literal ESM/CJS imports and exports; records resolved relative edges, unresolved local imports, dynamic import expressions, `import.meta.glob` sites, and direct importers for `server/integrations/titan-revenue/` and `server/integrations/field-link/vendor/`. It excludes checked-in `dist`, transient folders and symlink traversals. Marked `live: unverified` on all ownership results.
- Added four deterministic tests at `tests/infrastructure/import-ownership-audit.test.mjs` for importer parsing, extension/index resolution, local integration edge tracking vs donor archives, unresolved imports, dynamic reporting and read-only symlink/exclusion behavior. Await current-head CI before claiming pass.
- Confirmed build ownership in `vite.config.ts`: client root is `client/`, output `dist/public/`; `package.json` uses Vite, esbuild of `server/index.ts`, and `scripts/build-server-deps.js`. The dev Vite server bypasses the standalone Vite config. These facts distinguish generated outputs from canonical frontend/server sources.
- This is a conservative static graph, **not runtime reachability evidence**, because aliases, loaders, dynamic module names, provider configuration, plugin discovery and packaging can add edges. Do not remove any donor or vendor files yet.

**Remaining:** execute CLI in a complete checkout, resolve dynamic/alias ownership and direct runtime edges, compare divergent donor features, preserve vendor license terms, and verify installed application/CI acceptance.

## Pass 13 — tested import graph extended to explicit source roots

- Verified completed Pass 12 CI on the PR head: production build passed; **5,971 passed / 3 failed / 13 skipped**, including the four newly added import ownership tests. Three workforce tests, migration inventory and informational typecheck remain failing.
- Extended the read-only `scripts/audit-import-ownership.mjs` with cycle-safe transitive graph traversal from explicit `server/index.ts`, `client/src/main.tsx`, and `scripts/build-server-deps.js` entrypoints. The report lists actually found/missing roots, statically reachable file count and reachability booleans for targeted Field/revenue integration candidates.
- Added handling for the **verified** Vite path aliases `@/` and `@shared/` as source imports; unknown aliases remain unresolved rather than being invented. Reporting now distinguishes resolved alias edges and unresolved alias specifiers from relative imports.
- Added two further test cases covering cyclic/transitive graphs, missing entrypoints, configured aliases, and alias-linked browser reachability. These checks require new CI confirmation before pass status can be declared.
- Explicitly retained `live: unverified` throughout. Static reachability is not proof of runtime availability, and a missing edge is not a reason to delete donor/vendor code. No code paths, license headers, vendor copies or source archives removed.

**Next:** run static import audit against a complete checkout, resolve route/loader/plugin registry owners and analyze selected divergent donor implementations before any runtime file consolidation.

## Pass 14 — dynamic plugin manifests and runtime boundary

- Verified completed Pass 13 GitHub Actions: production build succeeded; **5,975 tests passed / 3 failed / 13 skipped**. All four new import graph assertions and previous PR audit/branding tests passed. The same three workforce tests, migration inventory, and informational typecheck remained failing. Earlier pass summary undercounted the four added Pass 13 test cases as two.
- Inspected the real `server/plugins/loader.ts`, the `server/index.ts` → `server/routes.ts` registration chain, and three existing plugin manifests. The loader dynamically resolves `plugins/<name>/plugin.json` and its declared `entryPoint`/`registerFunction`, with DB enable checks and compiled JavaScript fallback. A plugin can still refuse registration under its own gates.
- Added `scripts/audit-plugin-manifests.mjs`, a read-only CLI to inspect manifest format/name/directory, entrypoint presence, TypeScript-to-JS fallback candidates, invalid/missing registration names, duplicate plugin names, and unsafe entrypoint traversal. It never imports plugin code or changes flags; `enabled`, `registered`, `runtime` explicitly remain **unverified**.
- Added six Node fixture tests at `tests/infrastructure/plugin-manifest-inventory.test.mjs` for that discovery inventory. These tests await the current CI run.
- Grounded descriptions: `comms` and `workforce-runtime` manifests state they are internal enable-gated; `titan-workforce-bridge` is explicitly preview-only. This is *manifest intent*, not live functionality.
- Added manifest/runtime findings and CLI instructions to `docs/SUPERCHARGED_BLOB_DUPLICATION_AUDIT.md`; source, donor, vendor and plugin directories remain unmodified.

**Next:** verify current CI and investigate dynamic runtime plugin registration and divergent donor ownership without treating static absence as grounds for deletion.

## Pass 15 — runtime plugin discovery containment

- Verified completed Pass 14 GitHub Actions: production build **passed**, **5,981 tests passed / 3 failed / 13 skipped**, and all six new manifest-audit tests passed. Workforce composition/schema/timeout, migration inventory, and informational typecheck remain red.
- Found a concrete runtime discovery weakness: `server/plugins/loader.ts` read manifests from discovered `plugins/<folder>/plugin.json` but subsequently derived dynamic import directories from unverified `manifest.name`. It also accepted entrypoint strings without checking path escape before file import.
- Runtime discovery now skips symlinked plugin directories and manifest files; requires a correctly shaped plugin name exactly equal to the discovered directory; rejects missing, absolute, parent/relative traversal, backslash and wrong-extension entrypoints; and verifies `registerFunction` is a valid exported-identifier name.
- Before dynamic import, the loader resolves the real filesystem paths of both its initial selected entrypoint and any compiled fallback and requires they remain under the resolved plugin root. This protects against symlinked entry files escaping the plugin directory. Existing valid `plugin.json` semantics, database enable switches, TS/JS fallbacks and explicit registration-success rule are preserved.
- Added five source-contract regression tests in `tests/infrastructure/plugin-loader-safety.test.mjs`. These tests assert the safety invariants but are *not a substitute for an integration test that runs the loader against a database and malicious fixture plugins*. Current-head CI confirmation is still pending.
- Existing source/legal notices, donor archives, historical package and cache names, and user plugin settings remain untouched. No plugins were activated, removed or migrated.

**Remaining:** validate registration end-to-end, check actual runtime authorization/tenant boundaries, compare divergent donors, resolve license permissions, and repair unrelated CI failures before merging issue #54.

## Pass 16 — executable plugin activation and disk lookup policy

- Completed Pass 15 GitHub Actions: **5,986 passed / 3 failed / 13 skipped**, production build passed and all 48 PR-specific brand/source tests passed. The three workforce metadata/composition tests, migration inventory and informational typecheck remain failing.
- Investigated `server/plugins/loader.ts` beyond dynamic imports. Database enablement failures previously returned **true**, silently enabling a plugin when enablement could not be read. Now database errors **fail closed** (disabled) while **no setting** retains existing default-enabled compatibility semantics.
- Explicitly saved `false` previously fell through the falsy check to default `true`. The loader now distinguishes absent settings from stored values; only boolean/string true or `{enabled:true}` activates. Null, false and other values are disabled.
- `getPluginManifestFromDisk(name)` previously joined an unvalidated input into the plugin directory. It now checks kebab-case name, directory and manifest symlink status, realpath containment, manifest identity, extension/path traversal and exported-function identifier, returning `undefined` for invalid inputs. No on-disk manifests are changed.
- Added **six executable loader policy fixture tests** in `tests/infrastructure/plugin-loader-policy.test.mjs`, using extracted source functions and isolated filesystem/DB fakes rather than text-only assertions. They cover DB error vs missing setting, explicit enabled/disabled shapes, safe on-disk retrieval, traversal and malformed identity, and symlink rejection.
- These changes do not validate database-backed app integration or licensing, and new tests are pending current CI. Existing third-party and donor code preserved.

**Next:** verify the six tests in CI; inspect remaining plugin activation callers and distinguish optimistic in-memory toggles from actual runtime registration; plan divergent donor merge after license clearance.

## Pass 17 — activation intent versus current-process registration

- Verified Pass 16 GitHub Actions: production build **passed**, **5,992 tests passed / 3 failed / 13 skipped**, including all six executable enablement/on-disk manifest tests. The same three workforce test failures, migration inventory and informational typecheck failures persist.
- Inspected `server/plugins/loader.ts`, `server/routes/plugin-routes.ts`, and `server/routes/plugin-installer.ts`. Plugin enable/disable endpoints persist the desired setting, update an in-memory `enabled` flag, and request a server restart. **They do not unload registered routes or synchronously register newly enabled code.** Thus `enabled` and `registered` describe different facts until the restart completes.
- Extended `getPluginStatus()` to provide additive `requiresRestart: plugin.enabled !== plugin.registered`, while leaving the existing `registered` flag as evidence only of registration already performed by this process. Added `pending_restart` to the public plugin health status when those flags differ, instead of presenting the plugin as immediately healthy/disabled.
- Changed the plugin installer registration step's message from **“Plugin registered and enabled”** to **“Plugin enabled for next startup; runtime registration pending restart”**. The existing `requiresRestart: true` response and scheduled restart are preserved.
- Added five source-contract regression checks in `tests/infrastructure/plugin-lifecycle-status.test.mjs` for enable/disable transitions, separate in-memory flags, public health pending state, truthful installer message and admin restart scheduling. These tests await the current pass CI; they do not assert successful runtime unloading or startup.
- Source ownership, third-party notices, database schema, plugin manifests and external interfaces were preserved.

**Outstanding:** verify registration through a real restart including DB and permissions, handle restart failure and report state separately, resolve source consolidation and license issues, and repair independent CI failures.
