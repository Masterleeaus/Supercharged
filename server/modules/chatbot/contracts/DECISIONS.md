# Contracts: change requests applied (2026-11-09)

Owner: the contracts agent. This is the only folder that edits `contracts/`. Every change is additive. No method, field,
flag name or union member was renamed or removed. Required members were not added to existing interfaces.

## Change request table

| Request | Status | Reason |
|---|---|---|
| Money 1: PaymentStatus add partially_captured, partially_refunded, expired, disputed | Deferred | `commerce/money/payment-lifecycle.ts` uses `Record<PaymentStatus, ...>`, so widening breaks it. The money slice reads partial states from amounts. Owner to decide on expired and disputed. |
| Money 2: PricingRule add targetId, minQuantity, minSubtotalMinor, customerRef, perUnit | Applied | Optional fields. |
| Money 3: ShippingCartLine add productType | Applied | Optional field. |
| Money 4: TaxRate add compound | Applied | Optional field. |
| Money 5: PRICING_SCOPES shipping, PRICING_RULE_TYPES free_shipping | Applied | No exhaustive switch or Record uses these unions. |
| Events C1: WorkflowRun maxAttempts, idempotencyKey; dispatch options conversationId, maxAttempts | Applied | Optional fields. |
| Events C2: StructuredAction expiresAt, presentation, idempotencyKey | Applied | Optional fields. |
| Events C2: StructuredActionStatus "expired" | Deferred | Events D8 keeps expired out. Owner decides. |
| Events C3: claimBatch lease; markFailed attempts and last error; markDeadLetter | Applied | Lease and detail are optional parameters. markDeadLetter is an optional method. |
| Events C4: realtime routing for outbox topics | Applied | Named as an identity mapping: a topic goes to realtime only when it is an InboxEventType. Type alias `OutboxRealtimeTopic`. |
| AI C1: ModelMessage toolCalls | Applied | Optional field on messages. |
| AI C2: streaming HttpClient | Applied | New type `HttpStreamClient`. `HttpClient` is unchanged. |
| Channels 1: WhatsApp flag in CONTRACT_FLAGS | Applied | Key WHATSAPP_CHANNEL, value matches `channels/whatsapp`. |
| Channels 2: RawWebhook url | Applied | Optional field. |
| Channels 3: InboundMessage buttonText | Applied | Optional field. |
| Telegram: send ledger | Not applied | The ledger stays a port in its own folder. The runtime outbox decides on dedupe. |
| Telegram: TELEGRAM_CHANNEL_ENABLED flag | Applied | Key TELEGRAM_CHANNEL, value CHATBOT_TELEGRAM_CHANNEL_ENABLED. Optional request, off by default. |
| Messenger and framework hook: answerVerification on ChannelProvider | Applied | Optional method for the GET challenge. Read as the framework hook request. |
| Instagram: CHATBOT_INSTAGRAM_ENABLED | Applied | Key INSTAGRAM_ENABLED. |
| Reviews: CHATBOT_REVIEWS_ENABLED | Applied | Key REVIEWS_ENABLED. |
| Knowledge 1: replaceChunks chunk id | Applied | KnowledgeChunkInput adds optional id. Return type unchanged. |
| Knowledge 2: read of article records | Applied | New optional port KnowledgeArticleReader. |
| Knowledge 3: HttpRequest redirect option | Applied | Optional `redirect: "follow" | "manual"`. Default unchanged. |
| Knowledge 4: candidate read port | Applied | KnowledgeCandidateReader added with the same shape. The retriever keeps its own type. |
| Booking C4: listBookings on CalendarProvider | Applied | Optional method. Types CalendarBookingWindow and CalendarExternalBooking added. Booking C1 to C3 need no contract change. |
| Ops: ATTACHMENTS_ENABLED and ANALYTICS_EXPORT_ENABLED flags | Applied | Values CHATBOT_ATTACHMENTS_ENABLED and CHATBOT_ANALYTICS_EXPORT_ENABLED. |
| Ops: AnalyticsQuery.to is exclusive | Applied | Comment only. |
| Analytics metric requests (resolved_by_ai, avg_first_response_seconds) | Applied, already present | Both are already in ANALYTICS_METRICS. No edit. |
| Order-ops 4: chatbot-wide native order list | Applied | New optional port ChatbotOrderLister. The orders slice owns the implementation. |
| Order-ops 5: SKU lookup catalogue port | Applied | New port CatalogueVariantLookup, same shape as VariantLookup. |
| Order-ops 6: write proposal port | Applied | New port InventoryWriteProposer, kept apart from MarketplaceWriteOps so providers still compile. |
| Runtime: merge needs a storage change request | Deferred | A storage change, not a contract change. Doc comment only. |
| Commerce conversational: none | N/A | No request. |

## Decisions made here (for review)

1. Flag values for new flags use the CHATBOT_ prefix, as all existing flags do. Keys keep the names the requests used.
2. Telegram flag is added even though its request was optional. It is off by default and gates nothing yet.
3. Messenger challenge hook is an optional method, so existing providers still compile.
4. Order-ops write proposals take a MarketplaceConnectionRef plus chatbotId and ownerUserId, not the order-ops ConnectionScope type. The shapes match.
5. The PaymentStatus widening is deferred, not rejected, so the owner can choose.

## Checks

- Strict type check, contracts only: `tsc -p /tmp/cr-contracts/tc/tsconfig.json` with `contracts/index.ts` as the only entry. Exit 0.
- New test file: `tests/modules/chatbot-contracts.test.mjs`, 4 of 4 pass.
- Slices that import contracts, run after the change (`tests/modules/`):
  - agent-routes 23/23, ai 38/38, booking-providers 39/39, commerce-conversational 48/48, commerce-money 61/61,
    commerce-marketplace 35/35, events 28/28, inbox-drizzle 27/27, knowledge 58/58, runtime 33/33, voice 17/17,
    voice-call 39/39, widget 37/37.
  - whatsapp 27/27 when run alone. It showed one transient failure in the full run and passed on rerun.
- Not caused by contracts:
  - `chatbot-channels-telegram-messenger.test.mjs` fails to load. It imports `db/channels-telegram-messenger.ts`, which is not in `db/` now. The channels agent appears to have moved it while the run was going.
  - `chatbot-bookings-drizzle.test.mjs` 59/60. Item 4 checks a doc sentence. It also failed in the baseline run before the change.
- Full chatbot run after the change: 1079 tests, 1076 pass, 3 fail (the two above, plus the bookings doc item). Baseline run before the change: 1141 tests, 1140 pass, 1 fail (the bookings doc item). The totals differ because test files are being added and moved by other agents during the run.
- The checklist file `/home/claude/supercharged-fixes-checklist.md` was not updated. It is outside this folder. These changes add optional types and flags only, so no behaviour changes yet.
