# Customers and tags: decisions

Port of the Chatbot customer record, the Customer Tag extension and the Chatbot Agent tag endpoints into the Desk chatbot module.

Source files covered:
- `extensions/chatbot/System/Models/ChatbotCustomer.php`
- `extensions/chatbot/System/Http/Controllers/ChatbotCustomerController.php`
- `extensions/chatbot/System/Http/Requests/ChatbotCustomerRequest.php`
- `extensions/chatbot/database/migrations/2025_08_22_051700`, `..._051701`, `..._053222`, `2025_09_16_051839`
- `extensions/chatbot-customer-tag/` (all of it)
- `extensions/chatbot-agent/System/Http/Controllers/ChatbotCustomerTagController.php`

Files in this slice:
- `customer-storage.ts`: `CustomerStorage` interface and in-memory implementation. Every method takes `companyId` first and calls `requireCompanyId`.
- `customer-service.ts`: validation, identity normalisation, lookup, duplicates, merge, tags, feature flags.
- `schema.DRAFT.ts`: Drizzle tables for customers, identities, conversation links and tags. Not promoted.

## Feature flags (default OFF)

| Variable | Gates |
|---|---|
| `CHATBOT_CUSTOMERS_ENABLED` | Customer record, lookup, identity links, conversation links, contacts list |
| `CHATBOT_CUSTOMER_TAGS_ENABLED` | Tag create, edit, delete, list, assign, add, remove |
| `CHATBOT_CUSTOMER_MERGE_ENABLED` | Merge (needs the customers switch as well) |

Read per call through `featureEnabled()` in `server/lib/feature-flags.ts`. The source gate `MarketplaceHelper::isRegistered('chatbot-customer-tag')` is replaced by the first two switches. A missing tenant is refused with 403 before any flag is checked.

## Needs owner review

1. **Tags attach to conversations, not customers.** The source pivot is `ext_chatbot_conversation_customer_tag`, keyed on conversation. Kept.
2. **Conversation-to-customer link.** The source adds `chatbot_customer_id` to `ext_chatbot_conversations`. This slice cannot edit `chatbot_conversations`, so it drafts a separate `chatbot_customer_conversations` table, one row per conversation. The integration agent may turn it into a column.
3. **Identity uniqueness is per company.** The source index on `(channel, normalized_identifier)` is global, so one tenant's phone number would block or match another tenant's contact. The draft makes it `(company_id, channel, normalized_identifier)`.
4. **Linking an identity that another customer holds moves it.** This is the source `updateOrCreate` behaviour. Kept. Decide whether to refuse instead.
5. **Duplicates match on digits across channels.** The source `duplicates()` matches on the normalised value only, ignoring channel. Kept, so a phone and a WhatsApp number with the same digits are reported.
6. **Phone normalisation is digits-only.** `0412 345 678` and `+61 412 345 678` do not match, as in the source. Country-code normalisation is not added.
7. **Merge removes the source row.** The source does a hard delete. Its `merged_into_id` column is never written, so it is not ported. Merge moves identities and conversation links only. It does not copy name, email or payload from source to target. Desk also rejects a self-merge and a missing customer, which the source did not check.
8. **Tag names may repeat.** The source has no unique constraint on `tag`. Kept. Duplicate prevention applies to a tag assigned twice to one conversation, which the source also prevents with a unique pair.
9. **Deleting a tag removes its assignments.** The source leaves orphan pivot rows. Not ported as orphans.
10. **Create takes optional contact fields. Update requires name, email and phone.** The model columns are nullable, and `ChatbotCustomerRequest` requires all three on update. Email format is not validated, as in the source. Length limits follow the draft column sizes (255 for text).
11. **`lightenColor(tag_color, 55)` is an assumption.** The helper is a global MagicAI function that is not in the source tree. This slice mixes the colour toward white by 55 percent and returns null for anything other than `#rgb` or `#rrggbb`. Check it against the real helper.
12. **Tag colour is optional on create.** The agent API requires `tag_color`. The extension form allows null. Background colour is derived only when a colour is given.
13. **Changing a tag colour recomputes its background.** The source update did not touch `background_color`.
14. **`chatbot_id` gets a composite foreign key to `chatbots`.** The source has no foreign key. The draft adds one, nullable as in the source.
15. **Company scope replaces the source ownership checks.** The source checks `chatbot.user_id === auth()->id()` and filters customers by `user_id`. Desk uses `company_id` as the boundary. `userId` is kept only as a linked-user data field and is never used for authorization.
16. **No notes field.** The source has no contact notes, so none was added.
17. **Contacts list order.** Newest first by `createdAt`. The source used `id desc`, which is the same for auto-increment ids but not for UUIDs.
18. **Tag ids that are not in the company return 422.** This covers unknown ids and ids that belong to another company, which the source also treats as invalid.

## Personal data: deletion and export

What the source does:
- **Export:** nothing in these files. There is no export endpoint or download.
- **Deletion:** `ChatbotCustomerController::destroy` hard-deletes the `ext_chatbot_customers` row. It leaves `ext_chatbot_contact_identities` rows orphaned, leaves `chatbot_customer_id` on conversations pointing at the deleted id, and leaves conversation messages in place.
- **Retention:** `phone`, `email`, `ip_address`, `payload` and `avatar` are kept until deletion. There is no anonymisation.
- **Logs:** the extension logs through `ExtensionLogger` with no contact fields in the code shown. The Desk module writes no logs. Error messages name fields only (for example `phone is required`), never values.

What this port does:
- Deletion removes the customer row, its identities and its conversation links. Conversations and messages stay, as in the source.
- No export and no anonymisation are added, as the source has neither.

## Not ported

- **Blade views and language strings.** UI, out of scope.
- **Controller HTTP responses.** Redirects, flashes and JSON envelopes belong to the routes agent. Service methods return data and throw `ChatbotError`.
- **Demo gate** (`Helper::appIsDemo`). No Desk equivalent. The flags replace it.
- **Health check, metrics, extension events, webhook dispatcher, extension logger, access policy.** Host plumbing, not domain logic. Nothing in this slice calls them, so no interface was added. The access policy is replaced by company scope and the route layer.
- **`config/platform-quality.php`, `upgrade.php`, `extension.json`, `README.md`.** Packaging and runtime settings.
- **Drizzle storage implementation.** Only the in-memory store exists. The Drizzle tables are drafted in `schema.DRAFT.ts`.
- **`merged_into_id`.** Declared in a migration, never written by any source code.

## Source bugs noticed (not copied)

- `2025_08_22_051701_add_user_id_ext_chatbot_customers_table.php` and `2025_09_16_051839_add_enabled_sound_ext_chatbot_customers_table.php` both have a `down()` that drops the whole `ext_chatbot_customers` table, not the column they added.
- The source `unique` on identities is global, which breaks tenant isolation (item 3).
- The source merge does not check that either customer exists.

## Tests

`tests/modules/chatbot-customers.test.mjs` runs 27 tests, all passing:

```
node --test --experimental-transform-types tests/modules/chatbot-customers.test.mjs
```

The file has no database or Drizzle dependency. The existing `tests/modules/chatbot.test.mjs` fails in this environment because `drizzle-orm` is not installed, which is unrelated to this slice.

A strict `tsc` run over the two `.ts` files reports only missing Node type definitions, with no type errors in the slice's own code.

## Drizzle (2026-11-08)

Files:
- `../db/customers.ts`: Drizzle tables `chatbot_customers`, `chatbot_contact_identities`, `chatbot_customer_conversations`, `chatbot_customer_tags`, `chatbot_conversation_customer_tags`. Parent tables `chatbots` and `chatbot_conversations` are imported from `shared/schema.ts`, which is not edited. Not added to `shared/schema.ts`, and no migration is applied.
- `../db/customers-storage.ts`: `DrizzleCustomerStorage`, which implements the existing `CustomerStorage` interface unchanged. Every statement filters by `company_id`. Every method takes the company id first and calls `requireCompanyId`.
- `customer-storage.ts`: the in-memory store is unchanged, except two helpers are exported (`emptyCustomerFields`, `definedOnly`). The class lives in `db/` so the in-memory file does not load drizzle-orm, which the existing customers test does not need.
- Tests: `tests/modules/chatbot-customers-drizzle.test.mjs`, 18 tests, all passing.

Decisions:

1. **Identity uniqueness is per company.** Unique index on `(company_id, channel, normalized_identifier)`. The upsert conflicts on that key, so it cannot match another tenant's row (UNVERIFIED against Postgres). Test: the schema index and the rendered `ON CONFLICT` both use the company key.
2. **Tenancy at table level.** Every table has a NOT NULL `company_id`. Every foreign key starts with `company_id`, so a child cannot point at another company's parent.
3. **Merge in one transaction (UNVERIFIED against Postgres).** Order: check both customers exist in the company, move identities, move conversation links, delete the source. If either customer is missing, nothing changes and the result is null. The store also refuses a self-merge itself (the service already does), so a self-merge cannot delete the only copy.
4. **Delete order.** `deleteTag` deletes assignments first, in one transaction, because they reference the tag (UNVERIFIED against Postgres). The service already removes identities and links before a customer row, so the foreign keys do not block a customer delete.
5. **Tag assignments.** `setTagAssignments` checks tag ownership in the company and drops unknown or foreign tag ids, as the memory store does. Repeats are removed in code, and the pair index rejects duplicates (UNVERIFIED against Postgres). `addTagAssignment` is `ON CONFLICT DO NOTHING` on `(company_id, conversation_id, customer_tag_id)`.
6. **Sort order is the database collation.** `listTags` sorts by `tag` in SQL, so the order can differ from the memory store's `localeCompare` for accented or mixed-case names. Accepted; the service does not depend on the exact order.
7. **No real database yet.** Tests render each statement with `PgDialect.sqlToQuery(query.getSQL())` and run it against a stub client that returns no rows. The `onQuery` option exists only for those tests.
8. **Duplicate draft.** `customers/schema.DRAFT.ts` defines the same table names with the same columns, and imports `chatbots` from `../schema.DRAFT.ts`. The integration agent must keep one definition. `db/customers.ts` is the one these tests use.

Test run:
- Command: `NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-customers-drizzle.test.mjs`. Result: 18 of 18 pass.
- `/home/claude/builder-test-deps/register.mjs` cannot resolve `drizzle-orm`, so the integration hook is used.
- Existing `tests/modules/chatbot-customers.test.mjs`: 27 of 27 pass, with no hook.

