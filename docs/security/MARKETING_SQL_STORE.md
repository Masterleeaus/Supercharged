# Marketing SQL adapter — Pass 8

`server/modules/marketing/sql-store.ts` implements all nine methods in the existing `MarketingStore` contract using parameterised PostgreSQL, a company_id predicate on every read and write, and the existing `withTenant` transaction wrapper (restricted DB role + transaction-local app.company_id).

The implementation matches `migrations/archive/DRAFT_marketing.sql`. **That draft is not part of the numbered migration sequence and has not been applied by this change.** The SQL adapter is intentionally an opt-in dependency and does not replace the fail-closed `createDrizzleMarketingStore()` placeholder used by unfinished production wiring. Do not enable Marketing until schema promotion and independent database-backed integration tests are complete.

The SQL store uses fixed column allowlists for updates, JSON-encodes structured sections, and retains per-company slug uniqueness through the proposed database unique constraint. It does not implement public hosting, HTML rendering, outbound delivery or publication concurrency controls.

Testing should verify two real tenant DB roles/companies and concurrent status transitions before production use.
