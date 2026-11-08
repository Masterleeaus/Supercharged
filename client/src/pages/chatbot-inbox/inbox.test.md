# Staff inbox: browser checklist

Run in a browser after the owner adds the route and mounts the agent routes. Test on a desktop window and on an iPad (landscape and portrait).

## Setup

- [ ] Server flag `DESK_CHATBOT_AGENT_ROUTES` is `"true"`, and the agent router is mounted under `/api/chatbot/agent`.
- [ ] Client build has the route `/app/chatbot-inbox` (see DECISIONS.md).
- [ ] Sign in as a user with role `admin` or `agent`. Have at least one AI-handled chat, one human-handled chat and one closed chat.

## Pending state (before the backend is mounted)

- [ ] Open `/app/chatbot-inbox`. The page shows "Staff inbox is not switched on yet" and no conversations.
- [ ] No request sends data or changes a chat. Check the network tab: only GET `/api/chatbot/agent/inbox` appears.
- [ ] The page does not show a fake empty list as if the inbox worked.

## Conversation list

- [ ] Rows show a short id, the channel name, AI or Human agent, and New or Closed.
- [ ] Status filter: All, New, Closed. Each change reloads the list and goes to page 1.
- [ ] Assigned filter: All, AI agent, Human agent. The request carries `handler=ai` or `handler=human`.
- [ ] Channel filter lists only channels on the current page. Choosing one hides other rows.
- [ ] Sort (Newest first and Oldest first) reorders the rows on the current page.
- [ ] Unread only: ticking it shows nothing, and the note under it says counts are not sent yet. No row shows a badge.
- [ ] Prev is disabled on page 1. Next is disabled on the last page. The "Page n of m" label is right.
- [ ] A filter that matches nothing shows "No conversations match these filters."
- [ ] The first conversation opens automatically. Clicking a row marks it with `aria-current` and loads its thread.

## Thread

- [ ] Customer messages sit on the left and are labelled Customer. AI and staff messages sit on the right. Staff messages show Staff.
- [ ] Messages are in time order, oldest at the top, newest at the bottom.
- [ ] Internal notes show a dashed amber box labelled "Internal note, staff only".
- [ ] The thread refreshes about every 10 seconds without losing the typed draft.

## Composer and internal notes

- [ ] Send is disabled when the box is empty or only spaces.
- [ ] The counter shows `n / 10000`. Above 10000 characters, Send is disabled and the counter turns red.
- [ ] With the internal-note switch off, a reply sends and the text clears. The request body is `{"message": ..., "isInternalNote": false}`.
- [ ] With the switch on, the button reads "Save note". The request body has `"isInternalNote": true`. The note appears in amber. Confirm on the customer side that the note is absent.
- [ ] While the AI handles a chat, a hint says to take over first. The hint is hidden while the note switch is on.
- [ ] If the channel rejects a customer reply, a toast says "Saved, not delivered". The message still appears in the thread.

## Handoff and close

- [ ] AI-handled chat: "Take over" shows. Clicking it switches the badge to Human agent, the button becomes "Hand back to AI", and the list row changes.
- [ ] Human-handled chat: "Hand back to AI" shows. Clicking it switches the badge back to AI agent and the staff id in the contact panel clears.
- [ ] Close ticket asks for confirmation ("Confirm close" and "Keep open"). "Keep open" changes nothing.
- [ ] After closing, the badge shows Closed, the actions and composer are disabled, and the note "This ticket is closed." shows.
- [ ] Click "Take over" twice quickly: only one success toast, and the state is Human agent.

## Contact panel

- [ ] Shows ID, channel, ticket status, handler, staff member (or None) and updated time.
- [ ] The Tags section reads "Pending backend". The Customer section shows no name, IP or country.
- [ ] The panel shows on desktop and landscape iPad (1024 px and wider). It is hidden on narrower screens by design.

## Roles and errors

- [ ] Sign in as `manager`. The action bar and composer are gone. The text "Your role can read conversations but not reply or change them." shows. Reads still work.
- [ ] A 403 from a write shows the toast "Your role does not allow this action."
- [ ] Open a conversation that another company owns (or a deleted one). The thread shows "Conversation not found", not another company's messages.
- [ ] Stop the server during polling. The page keeps the last data and does not crash.

## Layout

- [ ] Desktop: three columns. Below 768 px the list and thread stack; check the thread is still usable.
- [ ] iPad landscape: list, thread and contact panel are all visible, and the thread scrolls on its own.
- [ ] Dark mode: badges, the amber note and the muted text are readable.
