# Supercharged — verified Git blob duplication inventory

**Snapshot:** default `main` tree, `truncated: false`; generated during issue #54 Pass 10.  
**Method:** group tracked **blob** paths by exact Git blob SHA-1. This proves byte-for-byte identical Git content, not semantic equivalence, safe deletion, import ownership, licensing or runtime use.

| Metric | Count |
| --- | ---: |
| Tree entries (including directory entries) | 3003 |
| Tracked blob file paths | 2612 |
| Distinct blob hashes | 2536 |
| Exact duplicate SHA groups | 64 |
| File paths belonging to duplicate groups | 140 |
| Duplicate groups spanning active tree and donor archive | 25 |
| Duplicate groups spanning active tree and built dist | 35 |
| Other duplicate groups | 4 |

The labels `active`, `donor`, `generated`, `vendor`, and `root` below describe **directory locations only**. An active-tree path is not evidence that code executes in production. Do not delete, relicense or move files from this report without proving import/loader use and tests.

## Byte-identical active/donor groups

| SHA prefix | Live-tree candidate ↔ donor archive |
| --- | --- |
| `e5820af723cc` | `server/integrations/titan-revenue/revenue-booking-job-lifecycle.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/revenue-booking-job-lifecycle.mjs` |
| `36e899aced7b` | `server/integrations/titan-revenue/revenue-continuation-lifecycle.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/revenue-continuation-lifecycle.mjs` |
| `ad7531a2b458` | `server/integrations/titan-revenue/revenue-invoice-payment-lifecycle.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/revenue-invoice-payment-lifecycle.mjs` |
| `28a38c8d900c` | `server/integrations/titan-revenue/revenue-invoice-payment-outcome.test.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/revenue-invoice-payment-outcome.test.mjs` |
| `16e4955d11d6` | `server/integrations/titan-revenue/revenue-journey-correlation.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/revenue-journey-correlation.mjs` |
| `5565921afbab` | `server/integrations/titan-revenue/revenue-journey-projection.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/revenue-journey-projection.mjs` |
| `cacb4805c31a` | `server/integrations/titan-revenue/revenue-lead-opportunity-lifecycle.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/revenue-lead-opportunity-lifecycle.mjs` |
| `6d3bc036f2bd` | `server/integrations/titan-revenue/revenue-quote-lifecycle.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/revenue-quote-lifecycle.mjs` |
| `c558150664f5` | `server/integrations/titan-revenue/RevenueBookingJobLifecycle.schema.json` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/RevenueBookingJobLifecycle.schema.json` |
| `4aff3af5a2c3` | `server/integrations/titan-revenue/RevenueContinuationLifecycle.schema.json` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/RevenueContinuationLifecycle.schema.json` |
| `4a9575d1d805` | `server/integrations/titan-revenue/RevenueInvoicePaymentLifecycle.schema.json` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/RevenueInvoicePaymentLifecycle.schema.json` |
| `e2f2dc3d2225` | `server/integrations/titan-revenue/RevenueJourneyCorrelation.schema.json` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/RevenueJourneyCorrelation.schema.json` |
| `1edf6e2ffa89` | `server/integrations/titan-revenue/RevenueJourneyProjection.schema.json` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/RevenueJourneyProjection.schema.json` |
| `55c650324475` | `server/integrations/titan-revenue/RevenueLeadOpportunityLifecycle.schema.json` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/RevenueLeadOpportunityLifecycle.schema.json` |
| `23ad7c8570ec` | `server/integrations/titan-revenue/RevenueQuoteLifecycle.schema.json` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/revenue-journey/RevenueQuoteLifecycle.schema.json` |
| `7ba5cdec0890` | `server/integrations/field-link/vendor/authority/authority-evaluator.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/authority-evaluator.mjs` |
| `ebf9e7278efc` | `server/integrations/field-link/vendor/authority/authority-lease.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/authority-lease.mjs` |
| `b612a27c19c8` | `server/integrations/field-link/vendor/authority/autonomy.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/autonomy.mjs` |
| `adee918d16d3` | `server/integrations/field-link/vendor/authority/company-boundary.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/company-boundary.mjs` |
| `70c4a9cf98ca` | `server/integrations/field-link/vendor/authority/delegation.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/delegation.mjs` |
| `2302ef82a81f` | `server/integrations/field-link/vendor/authority/history-integrity.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/history-integrity.mjs` |
| `b50c7bbdaf16` | `server/integrations/field-link/vendor/authority/lease-control.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/lease-control.mjs` |
| `1f0af8175788` | `server/integrations/field-link/vendor/authority/protected-actions.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/protected-actions.mjs` |
| `0a24d9b8c0b9` | `server/integrations/field-link/vendor/authority/runtime-authority-gateway.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/runtime-authority-gateway.mjs` |
| `1db86864ace9` | `server/integrations/field-link/vendor/authority/worker-authority.mjs` ↔ `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/SOURCE_DONORS/GITHUB/packages/runtime/authority/worker-authority.mjs` |

## Built/dist and other byte-identical groups

These are mainly repeated generated static assets and images, plus exact copies elsewhere. Retain until packaging and deployment ownership are independently verified.

| SHA prefix | Identical paths |
| --- | --- |
| `bcc10b0d62ea` | `client/public/campaign_template.csv`; `dist/public/campaign_template.csv` |
| `51fb51f59775` | `client/public/favicon.png`; `dist/public/favicon.png` |
| `6da0564a0370` | `client/public/images/hero-card-appointments.png`; `dist/public/images/hero-card-appointments.png` |
| `b4314b33a448` | `client/public/images/hero-card-leads.png`; `dist/public/images/hero-card-leads.png` |
| `335994f97d1d` | `client/public/images/hero-card-sales.png`; `dist/public/images/hero-card-sales.png` |
| `2c727bba8531` | `client/public/images/hero-card-support.png`; `dist/public/images/hero-card-support.png` |
| `dec5411d1236` | `client/public/images/stock_images/ai_machine_learning__d444b91e.jpg`; `dist/public/images/stock_images/ai_machine_learning__d444b91e.jpg` |
| `8bbff106e644` | `client/public/images/stock_images/ai_technology_busine_1e218027.jpg`; `dist/public/images/stock_images/ai_technology_busine_1e218027.jpg` |
| `65bc73fb23dc` | `client/public/images/stock_images/ai_technology_busine_438e6bc2.jpg`; `dist/public/images/stock_images/ai_technology_busine_438e6bc2.jpg` |
| `6f0846add7e1` | `client/public/images/stock_images/ai_technology_busine_482a3692.jpg`; `dist/public/images/stock_images/ai_technology_busine_482a3692.jpg` |
| `18b854ca31aa` | `client/public/images/stock_images/ai_technology_busine_51895c91.jpg`; `dist/public/images/stock_images/ai_technology_busine_51895c91.jpg` |
| `49939e3e0a10` | `client/public/images/stock_images/ai_technology_busine_5f811b86.jpg`; `dist/public/images/stock_images/ai_technology_busine_5f811b86.jpg` |
| `642bd91027c3` | `client/public/images/stock_images/ai_technology_busine_ab1329af.jpg`; `dist/public/images/stock_images/ai_technology_busine_ab1329af.jpg` |
| `6aa9f5d9702d` | `client/public/images/stock_images/ai_technology_busine_c8311ea3.jpg`; `dist/public/images/stock_images/ai_technology_busine_c8311ea3.jpg` |
| `545e7d999fe2` | `client/public/images/stock_images/ai_technology_busine_e2087a76.jpg`; `client/public/images/stock_images/ai_voice_technology__2f3b67da.jpg`; `client/public/images/stock_images/professional_custome_ce78ec6c.jpg`; `dist/public/images/stock_images/ai_technology_busine_e2087a76.jpg`; `dist/public/images/stock_images/ai_voice_technology__2f3b67da.jpg`; `dist/public/images/stock_images/professional_custome_ce78ec6c.jpg` |
| `221529ede3eb` | `client/public/images/stock_images/analytics_dashboard__3fb5a841.jpg`; `client/public/images/stock_images/business_cost_reduct_4cb90234.jpg`; `dist/public/images/stock_images/analytics_dashboard__3fb5a841.jpg`; `dist/public/images/stock_images/business_cost_reduct_4cb90234.jpg` |
| `7860048af6fc` | `client/public/images/stock_images/business_professiona_0cefa99b.jpg`; `dist/public/images/stock_images/business_professiona_0cefa99b.jpg` |
| `846a1e319c61` | `client/public/images/stock_images/business_roi_calcula_56d75db8.jpg`; `dist/public/images/stock_images/business_roi_calcula_56d75db8.jpg` |
| `c3164bb3092b` | `client/public/images/stock_images/business_survey_feed_3da910ae.jpg`; `dist/public/images/stock_images/business_survey_feed_3da910ae.jpg` |
| `72a853291e67` | `client/public/images/stock_images/customer_support_tea_09b2efd1.jpg`; `dist/public/images/stock_images/customer_support_tea_09b2efd1.jpg` |
| `e4111d7572e6` | `client/public/images/stock_images/enterprise_security__35497ac5.jpg`; `dist/public/images/stock_images/enterprise_security__35497ac5.jpg` |
| `012092f407cc` | `client/public/images/stock_images/global_multilingual__ad881e71.jpg`; `dist/public/images/stock_images/global_multilingual__ad881e71.jpg` |
| `e1558079284b` | `client/public/images/stock_images/healthcare_appointme_3e181b08.jpg`; `dist/public/images/stock_images/healthcare_appointme_3e181b08.jpg` |
| `7b28a781aba5` | `client/public/images/stock_images/sales_team_analyzing_b2c2f5b3.jpg`; `dist/public/images/stock_images/sales_team_analyzing_b2c2f5b3.jpg` |
| `cec1d48c2fb9` | `client/public/images/stock_images/visual_workflow_flow_0015a75a.jpg`; `dist/public/images/stock_images/visual_workflow_flow_0015a75a.jpg` |
| `be23ced7b248` | `client/public/sitemap.xml`; `dist/public/sitemap.xml` |
| `2afe5e4925b2` | `client/public/uploads/favicon-1768991532506-452152217.png`; `client/public/uploads/seo/seo-ogImage-1765171052401.png`; `client/public/uploads/widgets/widget-icon-1768558485884-510168619.png`; `client/public/uploads/widgets/widget-icon-1769775602969-480118381.png`; `dist/public/uploads/favicon-1768991532506-452152217.png`; `dist/public/uploads/seo/seo-ogImage-1765171052401.png`; `dist/public/uploads/widgets/widget-icon-1768558485884-510168619.png`; `dist/public/uploads/widgets/widget-icon-1769775602969-480118381.png` |
| `b8e140f6f6bf` | `client/public/uploads/logo-1769082641733-518344877.png`; `dist/public/uploads/logo-1769082641733-518344877.png` |
| `b95a90b4e377` | `client/public/uploads/seo-ogImage-1768992012261-172344192.jpg`; `dist/public/uploads/seo-ogImage-1768992012261-172344192.jpg` |
| `b7c6fd2603bf` | `client/public/uploads/seo-ogImage-1769232357652-954696831.jpg`; `dist/public/uploads/seo-ogImage-1769232357652-954696831.jpg` |
| `2415bdf70108` | `client/public/uploads/seo/seo-ogImage-1765158948360.jpg`; `dist/public/uploads/seo/seo-ogImage-1765158948360.jpg` |
| `c3e11ab5d028` | `client/public/uploads/seo/seo-ogImage-1765158990903.svg`; `dist/public/uploads/seo/seo-ogImage-1765158990903.svg` |
| `23a40ac7c25c` | `client/public/uploads/widgets/widget-icon-1766394261982-101757922.png`; `dist/public/uploads/widgets/widget-icon-1766394261982-101757922.png` |
| `95cf82c0c2af` | `client/public/uploads/widgets/widget-icon-1767357830004-160407480.png`; `dist/public/uploads/widgets/widget-icon-1767357830004-160407480.png` |
| `6131fc15aecc` | `client/public/uploads/widgets/widget-icon-1768315104636-917114972.png`; `dist/public/uploads/widgets/widget-icon-1768315104636-917114972.png` |
| `1a82a7132182` | `vendor/dbos/packages/drizzle-datasource/.npmignore`; `vendor/dbos/packages/nodepg-datasource/.npmignore` |
| `c51515be8a55` | `vendor/dbos/packages/drizzle-datasource/jest.config.js`; `vendor/dbos/packages/nodepg-datasource/jest.config.js` |
| `71594af65124` | `vendor/dbos/packages/drizzle-datasource/tests/test-helpers.ts`; `vendor/dbos/packages/nodepg-datasource/tests/test-helpers.ts` |
| `eb1e505c7343` | `vendor/dbos/packages/drizzle-datasource/tsconfig.json`; `vendor/dbos/packages/nodepg-datasource/tsconfig.json` |

## Consolidation decision gate

1. Identify the module's runtime import/loader boundary and canonical owning package. Track asset URLs and Docker/PM2 packaging paths separately.
2. Verify source licensing and third-party notices (issue #37). Exact hashes do not grant redistribution or deletion rights.
3. Compare any *non-identical* donor variants semantically. Hash equality alone detects only exact copies and cannot determine which divergent file is newer.
4. Require regression tests, current build, and permission/integration checks before removing redundant runtime files; preserve historical provenance if donor archives are retained.
5. Track explicit file-by-file delete/retain/merge decisions in a future PR. **No files were removed for this audit.**

Related: `docs/SUPERCHARGED_CANONICAL_SOURCE_MAP.md` and issue #54. Current branch remains a draft PR; this report is not a completed code consolidation.

## Repeatable working-tree audit (Pass 11)

Use `node scripts/audit-source-duplicates.mjs` from the repository root to report byte-identical local files; use `node scripts/audit-source-duplicates.mjs --json` for structured, machine-readable output. A separate checkout can be audited with `--root=/absolute/path`. `--help` shows usage.

The working-tree audit computes SHA-256 of local file bytes and skips `.git`, `node_modules`, `.cache`, `.next`, `coverage`, and symbolic links. It does **not** delete or edit any files. It can include added/uncommitted local files: expect counts to differ from the historical **Git blob** snapshot above. A file's classification as an `active-tree` location is not evidence that it runs in production.

The four associated Node test cases in `tests/infrastructure/source-duplicate-audit.test.mjs` cover classification, exact active/donor and active/dist duplicates, same-name divergent bytes, skip directories, symlinks, and read-only behavior.

### Import and ownership findings

- `server/integrations/titan-revenue/revenue-invoice-payment-lifecycle.mjs` imports **its own sibling** `./revenue-journey-correlation.mjs`; the matching archived donor versions are byte-identical to the copied integration files at the snapshot. The related `revenue-invoice-payment-outcome.test.mjs` imports the same integration siblings. This is evidence of a *local import boundary*, not proof that every lifecycle is wired into deployed routes.
- `server/integrations/field-link/vendor/authority/runtime-authority-gateway.mjs` imports its sibling `./authority-evaluator.mjs`. The `server/integrations/field-link/vendor/NOTICE.md` identifies this as a copied Field runtime from a specific upstream revision, explicitly warns **not to edit these vendored files in place**, and notes unresolved Field source licensing. Removing the donor archival copy cannot be inferred safe merely because its hash matches.
- `server/integrations/field-link/client.ts` describes the target Field HTTP endpoints as **assumed** and a service-to-service auth scheme as **not yet implemented**, with fail-closed `DENY_ALL_COMPANY_MAP`; do not describe the integration as operating live.
- The repository's `package.json` claims `MIT`, whereas the original source headers and LICENSE/installation text contain CodeCanyon/Envato attribution. These conflicting provenance signals require licensing resolution before redistribution (issue #37).

**No donor, vendor, dist, revenue, or field-link files were removed or rewritten.** Runtime ownership and license checks must precede consolidation.

## Static import ownership scanner (Pass 12)

Use `node scripts/audit-import-ownership.mjs --json` to inspect source-file **literal relative imports** in a checked-out repository, or `node scripts/audit-import-ownership.mjs --root=/path/to/repo --json` for another checkout. Without `--json`, the tool prints a short inbound importer list for the targeted integration paths. The report includes resolved edges, unresolved relative specifiers, and dynamic import/glob call sites.

The scanner reads `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs` and `.cjs` files, excludes checked-in `dist/` and transient packages/caches, and does not follow symbolic links. It maps literal static import/re-export, side-effect imports, `require()`, and literal `import()` to local source files by common suffix/index candidates; imports through aliases, package exports, runtime-generated strings, conditionals, glob patterns and bundled artifacts may not be fully resolved.

**Crucial:** a direct importer edge is **not** proof of execution from the production entrypoint. Files with no static inbound edges may still be reached by a dynamic loader, test harness, plugin discovery, server runtime configuration, or compiled packaging. Therefore neither this scanner nor the exact SHA report recommends deletion by itself.

Four fixture-driven Node tests exercise parsing, suffix/index resolution, imported integration paths, donor exclusion, unresolved and dynamic call reporting, symlink skipping, and read-only scanning. The tests are pending GitHub Actions on the latest head.

## Pass 13 — conservative transitive ownership

The import auditor now computes transitive, **literal-path** reachability from available source entrypoints `server/index.ts`, `client/src/main.tsx`, and `scripts/build-server-deps.js`. It reports which explicit roots were found, missing roots, total statically traversed files, and whether a targeted integration file has a chain of resolved imports from those roots.

It also resolves the verified Vite aliases `@/` → `client/src/` and `@shared/` → `shared/` (as configured in `vite.config.ts`), reporting resolved and unresolved alias imports separately. This improves browser/client coverage over relative imports alone. It does not resolve arbitrary third-party package names, plugin registries, route registration through runtime reflection, aliases unknown to the build, worker import maps, or loader-generated paths.

A file that is not statically reachable may still be required at runtime; every ownership row continues to report `live: "unverified"`. The auditor **never deletes source or treats lack of inbound imports as grounds for removal**. Six dedicated import scanner tests cover parsing, extension resolution, cycles, entrypoints, Vite aliases and unresolved imports. New tests require a completed CI check.

## Pass 14 — plugin loader discovery and manifest ownership

The actual runtime in `server/plugins/loader.ts` searches `<process.cwd()>/plugins/*/plugin.json`. Each manifest declares `name`, `entryPoint`, and `registerFunction`; the loader checks a database `plugin_<name>_enabled` setting, loads the entrypoint dynamically with TypeScript/compiled JS fallback handling, invokes the registration function, and accepts only explicit successful registration. The loader's default setting behavior is **enabled if missing or on DB-read failure**, but a plugin's own code may impose stricter environment/permission gates. Do not treat manifest presence, source imports or default settings as evidence that a plugin is registered.

New repeatable command: `node scripts/audit-plugin-manifests.mjs --json` (or `--root=/path`). This read-only audit inventories manifest names, declared entrypoints, compiled fallback candidates, candidate file presence, duplicate names, folder mismatches, malformed JSON, invalid register function identifiers, and paths escaping plugin folders. It reports each plugin's `enabled`, `registered`, and `runtime` status as `unverified` rather than claiming execution or authorization.

Inspected manifests:
- `plugins/comms/plugin.json` wraps chatbot and approvals, with internal enable gating; explicitly disclaims live inbox/campaigns/marketing.
- `plugins/workforce-runtime/plugin.json` wraps workforce runtime and related capabilities, with internal enable gating; it is not proof of active agents.
- `plugins/titan-workforce-bridge/plugin.json` is described as fail-closed and preview-only, and does not by itself execute agents or send messages.

Six Node fixture tests at `tests/infrastructure/plugin-manifest-inventory.test.mjs` cover entrypoint presence, compiled TypeScript fallback, folder mismatch, missing entrypoint, duplicate names/invalid JSON, path escape and a missing plugins directory. The current CI must finish before those six tests are counted as verified.

This resolves a *loader ownership identification gap*, not the remaining production reachability question. No manifest, source archive, vendor module, plugin enablement setting or database row was changed.
