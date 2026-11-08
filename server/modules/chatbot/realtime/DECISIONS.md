# Realtime over Server-Sent Events: decisions

Implements the inbox `EventPublisher` (inbox/ports.ts, inbox/event-publisher.ts) and the `StreamingRuntime`
contract (contracts/runtime.ts) over Server-Sent Events. No vendor SDK, no WebSocket.
Tests: `tests/modules/chatbot-realtime.test.mjs`, 18 of 18 pass. Scoped strict check: `tc-realtime`, passes.

## Decisions

1. **Transport is SSE.** Resolves option 2 of the inbox DECISIONS.md top question. Ably is not ported.
2. **Routing is by company, in the hub.** A frame reaches a stream only when the stream's company equals the
   company the frame names. A malformed company id routes to nobody. Customer streams never get inbox events.
3. **One stream per staff member per company.** A second connection for the same staff id closes the first.
   Two companies may use the same staff id; they are separate streams.
4. **Auth comes only from `resolveAuth(req)`.** The handler never reads `req.url`, `req.query` or `req.params`.
   A null result, a thrown error, or an invalid shape gets 401 with a fixed JSON body and no detail.
5. **Customer scope is one conversation.** Customer streams receive `token`, `typing`, `done` and `error` frames
   for their own conversation only.
6. **Staff scope is the whole company.** Staff streams receive every inbox event and every token frame of their company.
7. **Heartbeat is a comment line every 25 seconds** (`: heartbeat`). Timer is injected (`Scheduler`), and it is
   cleared on close.
8. **Only the response's `close` event releases a stream.** Request `close` is not used, because on newer
   Node versions it can fire early on a GET.
9. **Slow clients are dropped.** When more than 1 MiB waits in a response, the stream is removed and ended.
10. **Write failure releases the stream.** A heartbeat or frame that cannot be written removes the stream.
11. **Stream replies are not persisted on error.** A provider error or a thrown iterator sends a generic
    `reply_failed` error frame, persists nothing, and never forwards the provider message.
12. **Persistence happens once, at the end, through an injected `persistReply` hook.** Its returned message id is
    the summary's `messageId`. Without the hook, `messageId` is the stream id.
13. **Usage is last-report-wins.** Providers send running totals.
14. **`shutdown` closeAll is final.** After `closeAll()` the hub ends any new stream at once.
15. **Express types are structural.** `RealtimeRequest` and `RealtimeResponse` are minimal shapes. Express's
    own Request and Response satisfy them (checked in the scratch folder). No `express` import in this folder.
16. **Retry hint is 3 seconds**, sent with a `ready` frame on connect.
17. **No flag is read here.** The stream route is not mounted, so the integration pass should gate the route with a
    contract flag. Not decided here: which flag. Checklist entry not written (outside this agent's write scope).

## Change requests against contracts/

None.

## Open for the integration pass

- Mount `createSseStreamHandler` on a GET route behind the auth middleware, and pass the staff and customer
  auth function. Choose the flag.
- Wire `createSsePublisher(hub)` as the inbox `EventPublisher`, and `createSseStreamingRuntime({ hub, persistReply })`.
- Call `hub.closeAll()` at shutdown.

## Wiring and stream identity (G1, 2026-11-09)

18. **Transport is SSE, default, not confirmed by the owner.** Recorded as a default in item 1 above. Change it only with the owner's answer.
19. **One stream per identity.** A second connection replaces the first for the same staff member in a company, and for the same conversation for customers. Before this change, only staff were replaced.
20. **routeToStaff.** Frames for staff only (conversation events, reply failures). Customer streams never receive them.
21. **Store events.** createSseStoreEventSink routes conversation topics to staff of the company, with conversationId set from the aggregate id. Called after commit, through runtime/store-events.ts.
22. **Reply events.** reply.stored goes to the conversation's staff and customer streams, with the message id only. reply.failed goes to staff only, with the code and no text. reply.duplicate and reply.turn_unmarked send nothing.
23. **Tests.** realtime-wiring.test.mjs, 8 of 8 pass. The existing chatbot-realtime.test.mjs still passes, 18 of 18.
