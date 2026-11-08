# Marketplace slice: decisions

Date of this section: 2026-11-08. Source: `extensions/chatbot-ecommerce/System/Services/Marketplace*.php`, `Gateway*Transport.php`, `Support/Marketplace*.php`, `config/chatbot-ecommerce.php` (marketplaces block). Each entry says what changed from the PHP, or what was added.

## Behaviour changes

1. **Capability names.** Connections advertise the contract names (`read_listings`, `write_price`, `write_inventory`, `write_listing`). PHP used operation names. Mapping: `update_price` to `write_price`, `update_inventory` to `write_inventory`, `update_listing`, `pause_listing` and `resume_listing` to `write_listing`.
2. **Bulk over the cap is refused.** PHP silently cut the selection to `maximum_items` (250). Here a larger selection throws `bulk_cap` before any batch row is written. The seller narrows the filters.
3. **Spend check on price (new).** A single price change above 2000 bps (20 percent) of the current price is refused at prepare with `spend_limit`. PHP had no such check. The value is `maxPriceChangeBps` in `WriteConfig`. Review it.
4. **Bulk spend cap (new).** The sum of absolute price changes in one batch must stay at or under 500000 minor units. Refused at preview with `spend_limit`. Review it.
5. **Role check (new).** Writes need the `owner` or `admin` role, and the connection owner must be the acting user. PHP checked owner only.
6. **Percentage bulk prices use basis points.** PHP used a float percent. CONVENTIONS section 3 says integers only, so `percentage_bps` replaces it. 1000 means 10.00 percent.
7. **Provider failures do not throw.** A write that fails at the provider returns the proposal with status `failed` and error code `provider_unavailable`. PHP rethrew. Returning the result lets a bulk batch record the item and continue. The provider's message is never stored.
8. **Retry after failure.** A `failed` proposal moves back to `approved` before it runs again. PHP set `executing` directly. The state machine in `operations.ts` is enforced on every change.
9. **Unknown outcome.** If the provider throws during a write, the outcome is unknown. The proposal is `failed` and keeps its idempotency key, so a retry is safe only if the provider honours the key. The contract says it must.
10. **Confirmation is always required.** PHP's `require_approval = false` path (auto-approve) is dropped. Every write and every batch needs a token from the seller.
11. **Confirmation tokens.** HMAC-SHA256 over a payload with a random `jti` and an expiry. The signing secret is injected and must be at least 32 characters. Construction throws otherwise, even when the flag is off (PHP checked per call). Only the SHA-256 hash of a token is stored on the proposal or batch.
12. **Idempotency.** The same key with the same action returns the same proposal and re-issues a token. The same key with a different action throws `idempotency_conflict`.
13. **Write flag.** Writes are off unless `CHATBOT_MARKETPLACE_WRITE_ENABLED` is exactly `"true"`, read with `readFlag`. Bulk also needs the `bulkEnabled` option. Default false. PHP used `allow_bulk_writes` (config) and that path was not implemented past the assertion.
14. **Rate limiter.** A sliding window in app code. Two buckets per call: (company, provider) and (company across providers). Writes default to 10 per minute per provider, matching PHP `maximum_writes_per_minute`. Reads default to 60 per minute per provider. A denied call takes no slot. PHP used a fixed one-minute window stored in a database table, per connection and operation, and limited writes only.
15. **Circuit breaker (new, small).** Five failures in 60 seconds open the breaker for 60 seconds for that company and provider. A success closes it. A 429 with `Retry-After` pauses that pair. The breaker sits behind `RateLimitHooks`, as the contract says. PHP's breaker lives in another class and is not ported here.
16. **Synthetic observation on read success.** `observe()` is called with status 200 and no headers, because the provider ops do not return HTTP headers. Providers that surface quota headers need their own path. Not built.
17. **Errors in search results.** Each failed connection is reported as `provider_unavailable` or `rate_limited`, with no provider text. PHP stored a hash of the error message.
18. **Price before-state fields.** Read from `MarketplaceListing` fields (`priceMinor`, `quantity`, `title`, and `raw.status`, `raw.attributes`, `raw.description`) rather than PHP snapshot keys.
19. **Inventory headroom.** Internal available stock comes from the injected `inventoryAvailable` function. When it is absent the listing is not mapped, which is a warning only. PHP's reconciliation runtime is owned by another agent and is not ported here.

## Structure decisions

20. **Store port.** `MarketplaceStore` is an interface with an in-memory implementation for tests. Every read compares `companyId`. The Drizzle tables and company-scoped query builders exist. A Drizzle store adapter that implements the port is not built. The connection table belongs to the credentials area.
21. **Migration draft `0040_commerce_marketplace.sql`.** `0030` is taken by `0030_voice_call.sql`. No foreign keys yet, because the connection table is owned by the credentials area. Renumber at promotion if needed.
22. **Naming.** Input and output keys are camelCase (`priceMinor`), as in the contract. PHP used snake_case.
23. **Per-process limiter.** The rate limiter state is in memory. Several server instances would each have their own window. A shared store is needed before multi-instance deployment.

## Not built (out of scope or deferred)

- Inventory reconciliation, order import, listing intelligence, conversational commerce runtime (other agents).
- Drizzle store adapter (needs the connection table).
- Provider implementations and the gateway transport (`GatewayMarketplace*Transport.php`). Providers are injected objects. No HTTP is made in this folder.
- Shared rate-limit storage across instances.

## Section: providers, write request, tests (2026-11-09)

Files: `generic-provider.ts`, `memory-provider.ts` (new), `operations.ts` (type added), `write-runtime.ts` (two call sites), `index.ts` (two exports). Tests: `tests/modules/chatbot-commerce-marketplace-ops.test.mjs` (21 tests, all pass). The existing `chatbot-commerce-marketplace.test.mjs` (35) still passes.

### Decisions

1. **Generic provider over the injected HttpClient.** Operation names and endpoints (`/v1/marketplace/read`, `/v1/marketplace/write`, `listings.search`, `listing.price.update` and so on) follow the PHP gateway transports. No vendor SDK, no global fetch.
2. **Gateway URL is set by the operator and must be https.** It is never taken from a tenant. A tenant-supplied URL would be a server-side request forgery risk.
3. **Signing secret per connection.** It is read from the encrypted credential bag under `gateway_signing_secret` (at least 32 characters). If it is missing, every call is refused before any request. PHP signed writes only, and reads only when a secret was configured. Here reads are also signed, which is a behaviour change.
4. **Timeouts.** Reads 20 s, writes 30 s. Each request carries `timeoutMs`.
5. **Write results.** 2xx with the listing and `rollback_state` gives `applied`. 409 gives `conflict` with the marketplace's current hash. Other 4xx gives `rejected`. 429 gives `rejected` with `rate_limited`. A 5xx or a transport failure throws, because the outcome is unknown. The idempotency key makes a retry safe.
6. **A 2xx write without `rollback_state` throws.** It is not stored as applied, because a rollback would have nothing to restore.
7. **Provider text is never stored.** An error code is kept only when it matches `[a-z_]{1,64}`. Anything else becomes `provider_rejected`.
8. **Source hash is computed here**, over the normalised listing fields, so it does not depend on what the gateway sends.
9. **Orders are normalised to the PHP shape and amounts are not rounded.** Order import refuses a non-integer amount, as before.
10. **Writes refused before a request.** An empty expected source hash or idempotency key returns `rejected`. An unknown provider operation returns `rejected` with `unsupported_operation`.
11. **`providerOperation` added to the write request (additive).** Pause and resume share the capability `write_listing`, so a provider cannot tell them apart from the contract alone. `ProviderWriteRequest` and `ProviderRollbackRequest` add `providerOperation`. The runtime sets it on execute and rollback. The confirmation token is never part of any request.
12. **In-memory provider** is for tests and local runs only. It keeps listings per company and connection, checks the expected hash, replays by idempotency key, supports rollback, and records every request it receives.
13. **Confirmation and spend cap are unchanged.** The write runtime rules are the same. Tests confirm that a write without a token and a price change above the cap never reach the provider.

### Change requests (contracts, not edited here)

- `contracts/commerce.ts`: add optional `providerOperation?: string` to `MarketplaceWriteRequest` (and to the rollback request). Until then the runtime sends an extra field.
- `contracts/commerce.ts`: `CommerceCredentialStore` needs no change. The signing secret uses the existing bag.

### Not built

- A Drizzle adapter for `MarketplaceStore`. It needs the connection table, which belongs to the credentials area.
- Shared rate-limit storage across instances (already listed above).
