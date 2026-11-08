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
