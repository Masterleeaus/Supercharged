# Commerce conversational: decisions

Source: `extensions/chatbot-ecommerce/System/Services/ConversationalCommerceRuntime.php`, `CustomerCommunicationRuntime.php`,
`CustomerCommunicationCardRuntime.php`, `CustomerCommunicationContextRuntime.php`, `CommerceCredentialRuntime.php`,
`CommerceCredentialBridge.php`, `MarketplaceCardRuntime.php`, `ListingIntelligenceRuntime.php`, `Support/MarketplaceListingComposer.php`,
`Support/ListingComplianceScanner.php`, `Support/ClaimEvidenceValidator.php`, `Support/CommerceSessionAuthority.php`,
`Support/CredentialRedactor.php`, `Support/CustomerCommunicationAuthority.php`, `Support/CommerceRoleRouter.php`,
`Support/CommercePermissionMap.php`, `Support/ConversationContextStack.php`, `Http/Middleware/RequireCommerceSessionAuthority.php`.

## Behaviour changes (log in the checklist with the date)

1. **Staff approval needs a permission.** PHP checked only the approval token. Here a staff approver must also hold the
   permission from `APPROVAL_PERMISSION` (for example `manage-payments` for refunds). Only `seller_steward` and
   `customer_communications` may approve. `shopping_assistant` may not.
2. **Shoppers confirm a short list only.** `add_to_cart`, `apply_coupon`, `prepare_checkout`, `request_return`. A shopper
   cannot confirm a refund, a cancellation, or an address change.
3. **Refunds need `CHATBOT_PAYMENTS_ENABLED` set to exactly "true".** PHP had no such gate here.
4. **Actions with "execute within limits" still need an approver.** PHP ran them with no human. Here they start as
   `ready` and still need an approver with authority. No token is needed for `ready` only.
5. **Channel is limited to nine known channels.** PHP accepted any string.
6. **Credential `save()` on the contract needs an existing row** and throws not_found otherwise. `store()` creates. PHP
   used `updateOrCreate` for both.
7. **Credentials are sealed with SecretBox**, with companyId as associated data. The row holds a sealed JSON value and
   never a plaintext column. Summaries carry status, version and fingerprint only.
8. **Connection tests use an injected probe** over the injected HttpClient with a timeout. This module has no vendor
   endpoints. PHP called `ShopifyToolHandler` and `WooCommerceToolHandler` directly.
9. **Configuration refuses secret-looking keys** (same fragment list as `CredentialRedactor.php`). The error names the
   field only.
10. **Budget check runs before the cart line is added.** PHP ran it after `addLine` inside a transaction and relied on
    rollback. This port has no rollback, so it checks the prospective total first.
11. **Claim and execution are separate writes.** The claim moves `awaiting_approval` to `approved` by compare-and-set,
    then the executor runs, then the result is recorded. PHP wrapped execution in one DB transaction. If the process
    dies after the claim, the action stays `approved` and is refused on retry, so staff reconcile it by hand. Review this.
12. **Approval token lifetime is 15 minutes** for both scopes (PHP `action_ttl_minutes` default). Only the SHA-256 of the
    token is stored. Compare is constant time.
13. **Confidence is stored as basis points** (integer 0 to 10000). Code uses 0 to 1 numbers, as PHP does.
14. **Product references follow `ConversationContextStack::requireProductReference`.** The explicit id is trusted, and
    the company-scoped catalogue lookup is the guard. Inactive or foreign products return not_found.
15. **Listing intelligence is output only.** No `publish`, `write`, or `prepareWrite` is exported. PHP `prepareWrite` belongs
    to the marketplace write path and is not ported. Proposal status is `ready` or `blocked` only (DB check).
16. **Listing text is cut by UTF-16 length, not PHP byte length.** Limits are the same numbers.
17. **Unverified identity gets the cart only** (PHP behaviour kept). Orders, payments, fulfilments and returns are withheld.
18. **Drafts never send.** `canAutoSend` is advice for the channel layer. Auto-reply is off by default and every automatic
    limit is zero by default. PHP used `firstOrCreate` for the policy row. Here defaults are in code and the row is written
    only when the company saves a policy.
19. **Search results are not cached.** PHP used `Cache::remember`. No cache port exists in this slice.
20. **No foreign keys to shared tables.** CONVENTIONS asks for company_id and indexes. Composite FKs to `shared/schema.ts`
    were left out to keep the draft independent. Owner can add them at promotion.
21. **Session authority secret is a parameter**, not an env read. Minimum 32 characters. Tokens are HMAC-SHA256 over
    base64url JSON, and expiry is clamped to 60 to 86400 seconds.

## Not done (and why)

- **Outbox events for handoff and escalation** are not written. CONVENTIONS requires an OutboxEvent in the same transaction.
  The owner must wire the runtime `OutboxStorage` into `communications.ts` before integration.
- **No concrete adapters** for catalogue, cart, checkout, budget, orders, facts, refunds, or the shipping and fulfilment
  facts. Only ports exist. Implementations belong to the cart, orders and payments slices.
- **No Drizzle transaction wrapper.** Each store call is its own statement. See decision 11.
- **Brand-voice and product-profile CRUD** (`saveBrandVoice`, `saveProductProfile`, rule admin) are not ported. Only the
  compose, scan, claim-check and proposal path is.
- **Migration** is a draft at `db/migrations-draft/0002_commerce_conversational.sql`. Number 0002 may clash with another
  area's draft at promotion. Not applied.

## Change requests against contracts

None. The module imports `CommerceCredentialStore`, `CommerceCredentials`, `HttpClient`, `SealedSecret`, `SecretBox`,
`readFlag` and `CONTRACT_FLAGS` from `contracts/index.ts` as they are. Compile-time link in `credentials.ts`
(`asContractCredentialStore`).

## Adapters, handoff events, brand voice and the write path (2026-11-09)

Files: `read-adapters.ts`, `handoff-events.ts`, `brand-voice.ts`, `brand-voice-schema.ts`, `brand-voice-store.ts`,
`marketplace-write-path.ts`. Tests: `tests/modules/chatbot-commerce-conversational-adapters.test.mjs`.

Source note: `extensions/chatbot-ecommerce/` (the PHP runtimes, the brand voice model and controller) is not in this
checkout. Behaviour is taken from the TypeScript port (`listing-intelligence.ts` BrandGuide, `communications.ts` escalate,
`contracts/runtime.ts` OutboxStorage). Review against the PHP when it is available.

### Behaviour decisions

1. **Cart reader calls `getOrCreateCart`.** The session id is passed as the cart's conversation id. A session with no
   cart gets an empty active cart on first read, as the PHP getCart did. A read therefore writes a row once.
2. **Cart and order readers treat foreign rows as absent.** A cart or order whose company or chatbot differs returns
   null or is left out of the list. The order list filters after the service call too, so a leaky service is still safe.
3. **Order readers scope by session and optional customer identity only.** Whether a verified identity may see order
   facts stays in the communications layer (unchanged rule).
4. **Catalogue reader uses the marketplace read runtime.** `search` calls `searchListings` (provider calls, rate limited
   there). `lookup` reads `storedListing` only, with no provider call. Search limit is capped at 20, keywords at 200 characters.
   `ListingView` carries no companyId, so company scope depends on the read runtime's connection lookup. Flagged for review.
5. **Handoff is an outbox event only.** Topic `conversation.handoff` (the same name the inbox publisher uses). The
   dedupe key is `conversation.handoff:<conversationId>:<handoffId>`. A retry with the same handoff id reuses it. The
   handoff state change (conversation to a human) stays in the inbox service. The caller runs both in one transaction. (UNVERIFIED against Postgres.)
6. **OutboxStorage.append must dedupe.** A second append with an existing dedupeKey returns the existing row. The writer
   does not check for an existing row itself.
7. **Handoff input limits.** Priority is `low`, `normal` or `high`. Source is `ai` or `customer_rule`. Reason is at most 500
   characters. Summary is trimmed and capped at 1000. The payload carries no contact details and no tokens.
8. **Brand voice profile is one row per company and chatbot.** Name 1 to 120 characters. Tone up to 500 characters, optional.
   Locale must look like a language tag. Each term list holds at most 100 terms of at most 60 characters. Duplicates
   (case-insensitive) are refused. A term cannot be both preferred and forbidden. Save replaces the profile. There is
   no version history. Unknown input keys are ignored.
9. **Brand voice errors name the field only.** The message never echoes the submitted value.
10. **Write path has two steps and no other entry.** `prepare` stores the proposal and returns the runtime's token.
    `confirmAndExecute` calls `runtime.confirm` with that token, and calls `runtime.execute` only when the proposal comes
    back `approved`. `execute` is not exported on its own.
11. **Write path is behind `CHATBOT_MARKETPLACE_WRITE_ENABLED`.** It is checked before any runtime call, so the runtime is
    never reached when the flag is off. The runtime checks it again. Owner or admin role and connection ownership stay in
    the marketplace runtime.
12. **No conversational approval-gate row for marketplace writes.** The marketplace runtime's own confirmation token is
    the confirmation. Creating a second gate row would need a second token, so it is not done.

### Change requests

- **`db/`**: move `brand-voice-schema.ts` to `db/commerce-conversational-brand-voice.ts` at integration. CONVENTIONS asks for
  tables under `db/`. This area may not write there, so the table sits in this folder for now.
- **`db/migrations-draft/`**: a new draft (for example `0003_commerce_brand_voice.sql`) for the brand voice table. None
  written here. Not applied.
- **`communications.ts` escalate**: the owner should call `recordHandoff` there, with the escalation id as `handoffId`.
  Not wired in this pass, because that file is not owned here.

### Not done

- No HTTP route or controller for brand voice CRUD. The service and store are ready for the route owner.
- No Drizzle outbox store. The writer uses the `OutboxStorage` port.
- No `db/harness` run. The folder was empty when this was written.
- Type check: a scoped strict check over the six files reports no errors in them. Errors in `cart/cart-storage.ts` and
  `shared/schema.ts` come in through imports and belong to other areas.
