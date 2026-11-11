# BNPL owner brief (issue #25)

Date: 2026-11-09
Code read: `server/modules/chatbot/commerce/money/bnpl.ts` and `bnpl-lifecycle.ts`
Status: for your decision. No code was changed. Issue #25 is still open.

BNPL means "buy now, pay later". A customer pays in instalments.

## The short version

- There are 5 differences. Each one needs your choice.
- The PHP source is not in this repo. The Commerce Crew `extensions/chatbot-ecommerce/` folder is missing. The notes say the same (`server/modules/chatbot/commerce/conversational/DECISIONS.md:75`).
- So the "PHP" column below comes from code comments and the money notes in `server/modules/chatbot/commerce/money/DECISIONS.md`. It is not checked against PHP files.
- For two rows (webhook body and cancel), the PHP has no BNPL path at all. There is no PHP side to pick. Those rows are design choices.

## Plain words

- **Webhook**: a message a provider sends us when something changes.
- **Signature**: a code the provider adds to prove the message is real.
- **Replay**: the same message arriving twice. We should act on it once.
- **Idempotency**: sending the same request twice gives the same result, with no second effect.
- **Status**: where an offer is in its life, for example "accepted".

## The five differences

| # | Difference | What the TypeScript does | What the PHP does | Risk if the TypeScript is wrong | Recommended choice and reason |
|---|---|---|---|---|---|
| 1 | Status names | Six names: eligible, declined, accepted, active, completed, cancelled (`contracts/commerce.ts:244`). Moves are at `bnpl-lifecycle.ts:29-36`. There is no "expired" status. | Code comment lists: quoted, requires_action, approved, captured, refunded, declined, cancelled, expired (`bnpl-lifecycle.ts:7-8`). PHP file not found. `expireDue` expires offers (`DECISIONS.md:75`). | Old records or a provider using "approved" or "captured" will not map. Offers that should expire never do. | Keep the TypeScript names. Add "expired" if you want offers to expire. The names are already in the contract and tests, and the PHP names cannot be checked here. |
| 2 | Webhook body fields | Expects `{ id, type, data: { offer_id, status } }` (`bnpl-lifecycle.ts:89-113`). Anything else is refused. | Not found. `BnplRuntime.php` has no BNPL webhook (`bnpl-lifecycle.ts:4-5`, `DECISIONS.md:75`). | When a real BNPL provider is connected, its real messages will not parse. Every update is refused and offers never move. | Do not ship this shape yet. Write the parser when you choose the provider, from that provider's own documentation. No provider sends this shape today (`DECISIONS.md:92`). |
| 3 | Rejected webhook storage | A bad signature stores nothing and throws (`bnpl-lifecycle.ts:158-164`). Payments do the same (`payment-service.ts:380-386`). | Payment webhooks stored a row for a rejected call (`DECISIONS.md:33`). No BNPL PHP to compare. | No record of forged or broken calls. A wrong secret can go unnoticed. | Keep "store nothing". Add a log line for each refusal. You keep a trail, and unsigned calls cannot write to the database. |
| 4 | Replay (same webhook twice) | Same provider and event id seen before returns "replayed" with no write (`bnpl-lifecycle.ts:166-171`). The check runs before the lock (line 173), so two copies at the same moment can both pass. The second returns "ignored" (the database keeps the first row, `drizzle-store.ts:595`). Payments count replays as "ignored" (`payment-service.ts:392-394`). | Not found for BNPL. | The offer is never moved twice, because the status check stops it. Only the reported result can be wrong. | Use one word for replays everywhere. Recommend "replayed". Check again inside the lock. One extra read closes the race. |
| 5 | Cancel idempotency | `cancelOffer` takes no idempotency key (`bnpl-lifecycle.ts:76`, `:122`). A cancel of an already cancelled offer returns "cancelled" with no provider call (`:136-138`). Active or completed plans are refused (`:139-141`). The provider must confirm first (`:143-146`). | No BNPL cancel path (`DECISIONS.md:75`). Payment cancel in the TypeScript does use a key and stores the result (`payment-service.ts:314-329`). | The provider says "cancelled" but our app still shows an open offer. Staff may think the customer still owes instalments. | Add a required idempotency key to cancel, the same as payment cancel. Keep refusing active plans, and refund those instead. |

## Your decisions

Reply "accept" to take all five recommendations. Or name the row you want changed.

1. Status names: keep the TypeScript names. Add "expired" or not?
2. Webhook shape: wait until the provider is chosen, then write the parser?
3. Refused webhooks: store nothing, plus a log line?
4. Replays: "replayed" everywhere, checked again inside the lock?
5. Cancel: add a key like payments, and refund active plans instead of cancelling?

## What was not checked

- No PHP file was read. Every PHP statement is secondhand from comments and notes.
- No tests were run. This is a docs-only change.
- The race in row 4 is from reading the code. It is not tested.
- HANDOFF.md (line 54) already lists BNPL as "decisions needed".
