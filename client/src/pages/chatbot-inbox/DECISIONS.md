# Chatbot inbox (staff screens): decisions

Folder: `client/src/pages/chatbot-inbox/`. Owner of this section: staff inbox screens builder.
Sources: Commerce Crew `extensions/chatbot/resources/views/home/chats-history/` (main view and particles), and the mounted contracts in `server/modules/chatbot/agent-routes/`.

## Files

| File | Role |
| --- | --- |
| `types.ts` | Wire types that mirror `agent-routes/contracts.ts`. Limits from `validation.ts`. |
| `api.ts` | Typed calls for the six agent endpoints. `isInboxPending` detects the not-mounted or off state. |
| `format.ts` | Channel label and time formatting. |
| `conversation-list.tsx` | Filters, sort, unread badge and paging. |
| `conversation-thread.tsx` | Messages, composer, internal-note switch, take over, hand back, close. |
| `contact-panel.tsx` | Details of the open conversation. |
| `inbox-page.tsx` | Default export. Wires the three columns. |
| `inbox.test.md` | Browser checklist. |

## Wiring status

- **Wired to the agent router contract:** list, thread, staff reply and note, take over, hand back, close.
- **Pending: mount.** `agent-router.ts` is not imported by `server/routes.ts`. Until it is, the page shows a pending notice.
- **Pending: unread counts.** The contract has no unread field. The badge reads an optional `unreadCount` and shows only when the server sends it.
- **Pending: channel and assigned-to-me filters on the server.** The mounted list accepts only `handler`, `status`, `search`, `page` and `per_page`. Channel and sort run on the current page in the browser.
- **Pending: customer tags, name, IP and country.** Not in the agent contract. The panel says so.
- **Pending: realtime.** Polling (list 20 s, thread 10 s) until the transport is chosen (see the inbox DECISIONS, the open question on Ably).

## Decisions for the owner to review

1. **Route.** Add to `client/src/App.tsx`: `import ChatbotInboxPage from "@/pages/chatbot-inbox/inbox-page";` and `<Route path="/app/chatbot-inbox" component={ChatbotInboxPage} />`. App.tsx was not edited.
2. **Mount path.** Assumes `/api/chatbot/agent` (the default in `integration/mount.ts`). If the owner mounts elsewhere, change `AGENT_BASE` in `api.ts` only.
3. **Pending state, not fake success.** A 404 with no router error body, a 404 "Not found", or a 503 shows the pending notice. A missing conversation (404 "Conversation not found") shows its own message.
4. **Roles.** The client hides write controls only for `manager`, which the agent contract treats as read-only. The server still decides every write.
5. **"Assigned" filter means the handler (AI or human).** This matches core's agent filter. "Assigned to me" needs a staff-id filter on the server, so it is not built.
6. **Channel and sort run on the current page.** The server does not sort or filter by channel. Paging can therefore hide a channel that is on a later page. Owner can add server-side filters later.
7. **Unread only is shown but has no effect yet** until the server sends unread counts. Its note says so in the UI.
8. **Takeover is not required before a reply.** Core does not enforce it. The composer shows a hint instead of blocking.
9. **Close is one-way and asks for confirmation** (the server has no reopen). A closed ticket disables the composer; the server is not asked to refuse replies to it.
10. **Internal notes** use `isInternalNote: true`, and the server never delivers them. The amber box is visible to staff only.
11. **Contact panel shows on lg and wider** (1024 px and up). It is hidden on narrower screens by design, so a phone or portrait iPad does not see it.
12. **Polling** replaces realtime until the transport is chosen.
13. **Core filters not carried over.** Core's list also has date range, pin, export and delete. Pin, export, delete and customer tags have no Desk endpoint, so they are left out.
14. **Message order** is sorted in the browser by `createdAt`, oldest first, so the thread reads the same whatever order the server uses.

## Verification

- Syntax parse of the seven `.ts` and `.tsx` files with the scratch `parse-check.cjs`: 0 diagnostics each.
- Type check: not run. The client has no `node_modules` in this checkout, and react, react-query, wouter and lucide types are missing from the scratch deps. The owner should run a narrow check after the route is added.
- Browser checklist: `inbox.test.md`. Not run. It needs the mounted routes and a signed-in session.
