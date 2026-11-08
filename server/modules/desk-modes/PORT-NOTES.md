# Desk modes

One Desk codebase, two modes, two domains.

| Mode | Domain | Purpose |
|---|---|---|
| workforce | SuperchargedAt.Work | AI workforce: agents, runtime, catalogue, embed |
| comms | SyncedAt.Work | Omnichannel inbox, comms campaigns, marketing |

## Decisions (for review)

1. Campaigns sit under SyncedAt.Work (comms), not SuperchargedAt.Work. This changes the earlier plan that put campaigns on SuperchargedAt.Work.
2. Host to mode is an explicit allowlist, from config, not a pattern. Unknown hosts get no mode and no modules (fail closed).
3. A host can't be listed for both modes. Startup throws if it is.
4. `approvals` and `audit`, `auth`, `tenancy` are shared and mounted in both modes. Approvals are needed by campaigns too, since sending a message is an action.
5. `agent-embed` is workforce-only. Website chatbot widgets (comms) therefore don't use the embed module yet. If the chatbot needs the embed, add it to comms and review the origin rules first.
6. Modules named `inbox`, `campaigns` and `marketing` exist as unmounted modules, with draft migrations. The mode table reserves them. Nothing mounts them yet.

## Not done

- Nothing is mounted in `routes.ts` or `index.ts`. Mounting waits for the company_id migration and the journal repair.
- The host header is read at the edge; the resolver does no DNS or proxy trust. The reverse proxy must set Host and must not pass client-supplied forwarded hosts through to this check.

## Tests

`node --test tests/modules/desk-modes.test.mjs`: 15 of 15 pass.
