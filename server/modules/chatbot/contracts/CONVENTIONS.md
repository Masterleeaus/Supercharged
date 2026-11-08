# Chatbot port conventions

Read this before writing any code under `server/modules/chatbot/`. These rules apply to every builder in the parallel port.

The contracts in this folder are the agreed interfaces. Import them from `server/modules/chatbot/contracts/index.ts` only.

## 1. Ownership

Only the contracts agent edits files in `contracts/`. Anyone who needs a change writes a change request in their report (see section 10). Nobody edits a contract to make their own code compile.

Each builder owns only the folders assigned to them. The owner assigns agent names. The areas and their folders are:

| Area | Owned folder | Implements |
|---|---|---|
| Model providers | `server/modules/chatbot/ai/` | `ModelProvider` (OpenAI, Anthropic, optional Gemini), `ProviderRegistry`, failover |
| Channels | `server/modules/chatbot/channels/<kind>/` | `ChannelProvider` per kind: `whatsapp`, `telegram`, `messenger`, `instagram`, `voice`, `web` |
| Knowledge | `server/modules/chatbot/knowledge/` | `KnowledgeStorage`, `Retriever` |
| Runtime | `server/modules/chatbot/runtime/` | `ConversationRuntime`, `MessageRuntime`, `DraftRuntime`, `StreamingRuntime`, `WorkflowRuntime`, actions, `OutboxStorage`, `WebhookDispatcher`, `NotificationRuntime`, `ParticipantRuntime`, `PresenceRuntime`, `AttachmentStore`, `AnalyticsQueryPort` |
| Commerce: marketplace | `server/modules/chatbot/commerce/marketplace/` | `MarketplaceProvider`, `RateLimitHooks` |
| Commerce: payments and BNPL | `server/modules/chatbot/commerce/payments/` | `PaymentProvider`, `BnplProvider` |
| Commerce: tax and shipping | `server/modules/chatbot/commerce/tax-shipping/` | `TaxProvider`, `ShippingProvider` |
| Commerce: pricing | `server/modules/chatbot/commerce/pricing/` | `PricingProvider` |
| Commerce: rental and hire | `server/modules/chatbot/commerce/rental/` | Rental types and their storage |
| Commerce: credentials | `server/modules/chatbot/commerce/credentials/` | `CommerceCredentialStore` |
| Bookings | `server/modules/chatbot/booking-providers/` | `CalendarProvider` (Calendly, Cal.com), `ReminderSender` |
| Voice | `server/modules/chatbot/voice/` | `SpeechToText`, `TextToSpeech`, `CallProvider` |
| Widget | `server/modules/chatbot/widget/` | `WidgetPublicConfig`, `EmbedTokenIssuer`, `EmbedTokenVerifier` |
| Secrets | `server/modules/chatbot/secrets/` | `SecretBox` |

Do not edit `shared/schema.ts`, `App.tsx`, `routes.ts`, `server/index.ts`, `server/modules/chatbot/index.ts`, or any existing slice file (`bookings/`, `inbox/`, `cart/`, `orders/`, `customers/`, `fulfilment/`, `builder-routes/`, `booking-routes/`, `agent-routes/`). Wiring into the app is the owner's step, after integration.

## 2. Tenancy

- Every method that reads or writes tenant data takes `companyId` as its first argument.
- Every table has a `company_id` column, and every query filters on it.
- A row whose `company_id` differs from the argument is treated as absent. Return `null`, an empty list, or `false`. Never a 403 that reveals the row exists.
- Pure functions that touch no storage (`kind()`, `capabilities()`, `resolveAccount()`, `parseInbound()`, `evaluate()`) take no `companyId`.
- `SecretBox` binds `companyId` as associated data. A ciphertext from one company must fail to decrypt under another.

## 3. Money and time

- Money is an integer in the currency's minor unit (cents). Currency is an ISO 4217 upper-case code. No floats for money.
- Percentages are basis points (1000 = 10.00 percent). Integers only.
- Timestamps are `Date` in code and `timestamptz` in the database. Calendar dates in rental schedules are `date`.

## 4. Flags

- Read a flag only through `readFlag(name, env)` from `contracts/flags.ts`.
- A flag is on only when its value is exactly `"true"`. `"1"`, `"yes"`, `"on"`, and `"TRUE"` are off.
- Every flag defaults off. Use the names in `CONTRACT_FLAGS`, never a raw string.
- Existing slice flags keep their names. Do not add a second reader.

## 5. Secrets and HTTP

- Provider API keys come from the environment only (`MODEL_PROVIDER_ENV_KEYS`, or the company's encrypted credentials). No key in code, fixtures, logs, or error messages.
- Encrypt stored secrets with `SecretBox`. The key is `CHATBOT_SECRET_KEY`. The implementation fails closed: if the key is missing or malformed, construction throws. No plaintext fallback.
- Every outbound HTTP call goes through the injected `HttpClient` from `contracts/http.ts`, with a `timeoutMs`. Never call global `fetch` or a vendor SDK that bypasses the injected client.
- Webhook verification fails closed. Compare signatures in constant time. A missing secret is a rejection.

## 6. Realtime

- Realtime delivery uses the existing `EventPublisher` from `server/modules/chatbot/inbox/event-publisher.ts`.
- Do not name, import, or depend on any realtime vendor in code, comments, or config.
- State changes are written with an `OutboxEvent` in the same transaction. A publish failure never rolls back the state change.

## 7. Drizzle tables

- Drizzle tables live in `server/modules/chatbot/db/<area>.ts`, for example `db/commerce-pricing.ts`.
- Every table defines `company_id` with an index, and every unique constraint includes `company_id`.
- Do not add tables to `shared/schema.ts`. The owner promotes them later.
- Column names are snake_case. Use the names in the matching contract type, converted to snake_case.

## 8. Migrations

- SQL drafts go in `server/modules/chatbot/db/migrations-draft/`, named `<NNNN>_<area>.sql`, with a comment header listing the tables and constraints.
- Nothing is applied. Nothing is copied into the root `migrations/` folder until the owner promotes it.

## 9. Tests and checks

- No network in tests. Inject a fake `HttpClient` and an in-memory storage. A test that reaches the network fails the build.
- No test may read real provider keys.
- Test file location: `tests/modules/chatbot-<area>.test.mjs`.
- Test hook command, run from `/home/claude/desk-handoff/desk-review`:

  ```
  NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/<file>
  ```

  All chatbot tests: `/home/claude/integration-scratch/run-chatbot-tests.sh`.
- Do not run the repo's full `tsc`. The machine has 8 GB of memory and the full run exhausts it. Use a scoped tsconfig that lists only your files.

## 10. Reporting back

Each builder's final report is under 150 words and lists:

1. Files created or changed, with absolute paths. Only files in your owned folder.
2. Tests run, with pass and fail counts, using the hook command above.
3. Scoped type-check result: passed or failed, with the file list used.
4. Change requests against `contracts/`, if any. One line each: which file, which name, and why.
5. Decisions that change behaviour, one line each, so they can be logged in `/home/claude/supercharged-fixes-checklist.md` with the date.

Do not write report files. Put the report in the final message.
