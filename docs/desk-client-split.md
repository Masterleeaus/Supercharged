# Desk client split: workforce and comms screens (C5)

Status: design only. No client code is changed by this document.
Sources read: `client/src/App.tsx` (847 lines), `server/modules/desk-modes/` (C1 and C2).

## 1. Current state

- One React bundle serves every host. The client has no notion of a Desk mode.
- `Router()` in `App.tsx` chooses a router from the URL prefix and the auth state, not from the domain:
  - `/admin...` goes to `AdminRouter`, `AdminTeamMemberRouter` or the admin guard.
  - `/app...` goes to `UserRouter` or `TeamMemberRouter`, behind `UserGuard`.
  - Everything else goes to `PublicRouter`.
- Each `*Router` lists its screens as literal `<Route>` elements inside a wouter `<Switch>`. There is no route table.
- The messaging conversation screen is looked up from the plugin registry (`registry.getRoutes()`, id `messaging-conversations`, around line 100). Plugin routes bypass the static list.
- The server decides the mode from the Host header (C1). The server guard (C2) limits which modules a mode reaches. The client does not yet ask the server which mode it is in.

## 2. How the client should choose screens

Recommendation: one bundle, with the mode supplied by the server.

1. The server already resolves the mode from the Host. It should add `deskMode` (`"workforce"` or `"comms"`) to the payload the client already loads for the session (the `/me` or session response). This is the only source of truth.
2. A `DeskModeProvider` reads `deskMode` and exposes it. Until it has loaded, the client renders a loading state, not a default mode.
3. The client must not derive the mode from `window.location.hostname`. Hostnames are client-visible, and a wrong guess would show the wrong screens. The hostname may be used only for display text.
4. The client filter is for navigation only. The server guard is the control: a hidden screen whose API still answers is a bug the server must catch.

Alternative considered: two builds, one per domain. Rejected for now. It doubles the release work, and the decision to keep one codebase is already recorded in `server/modules/desk-modes/PORT-NOTES.md`.

## 3. Screen-to-mode mapping (proposed)

Mapping of the existing `UserRouter` paths. Entries marked "decision" need review.

| Screen (path) | Mode | Notes |
|---|---|---|
| `/app/agents` | workforce | AI workforce |
| `/app/prompt-templates` | workforce | |
| `/app/knowledge-base` | workforce | Decision: agents use it. Comms chatbot may need it too. |
| `/app/tools` | workforce | |
| `/app/voices`, `/app/phone-numbers` | workforce | Decision: voice agents. Phone inbox would be comms. |
| `/app/flows`, `/app/flows/*` (all flow routes) | workforce | |
| `/app/incoming-connections` | workforce | |
| `/app/developers` | workforce | Currently a placeholder |
| `/app/conversations` | comms | Omnichannel inbox (C4 inbox module) |
| `/app/campaigns`, `/app/campaigns/:id` | comms | Campaigns sit under comms (PORT-NOTES decision 1) |
| `/app/contacts` | comms | Decision: campaigns and inbox both use contacts |
| `/app/outbound` | comms | Currently a placeholder |
| `/app/tools/widgets` | comms | Chatbot widgets. Decision: check the chatbot module is comms-only. |
| `/app/calls`, `/app/calls/:id` | comms | Decision: call history is a contact record. Could be shared. |
| `/app/crm` | shared | Decision: needed by both; confirm before splitting |
| `/app/analytics` | per-mode variant | Same route, different widgets by mode |
| `/app/dashboard`, `/app` | per-mode variant | Home widgets differ by mode |
| `/app/approvals` | shared | Both modes raise approvals (PORT-NOTES decision 4) |
| `/app/settings`, `/app/billing`, `/app/transaction-history`, `/app/upgrade`, `/app/payment-result` | shared | |
| `/app/google-callback` | shared | OAuth return. Must work on both domains. |
| Marketing pages and content | comms, new | No client screens exist yet. Needed after C4 HTTP routes are mounted. |
| `/admin/campaigns/:id` | comms | Admin screen, same rule as campaigns |
| Public landing, blog, pricing | shared for now | Decision: a landing page per domain? |

## 4. What needs to change in App.tsx

1. **Mode provider.** Add a `DeskModeProvider` above `Router()`. It reads `deskMode` from the session response and renders a loading state until it has a value.
2. **Route table.** Replace the literal `<Route>` lists in `UserRouter`, `TeamMemberRouter` and the admin routers with one table per router:
   `{ path, component, modes: ['workforce' | 'comms' | 'shared'], roles? }`.
   Render only the entries whose `modes` include the current mode. Render them as a plain array inside `<Switch>` rather than wrapping each `Route` in a gate component. A wrapper may hide the direct children that `Switch` expects. Confirm this against the wouter version in use before relying on it (`node_modules` is not installed in this checkout).
3. **Unknown screen in the other mode** renders `NotFound`, the same as the server's 404. Do not redirect, so a comms screen is not revealed by a redirect.
4. **Root redirects.** The `<Route path="/">` redirects in `UserRouter` (around line 310) and `TeamMemberRouter` (around line 402) go to the mode home: `/app/agents` for workforce, `/app/conversations` for comms.
5. **Post-login redirect.** The `Router()` redirects around lines 758 to 766 (`/admin` or `/app`) should send each mode to its own home.
6. **Plugin routes.** The registry lookup around lines 100 to 110 must filter registry routes by mode. Plugin route metadata needs a `modes` field. Without it, a comms plugin route can appear on the workforce domain.
7. **Team members.** `TeamMemberRouter` applies two filters: the mode filter and the team permission filter. Both must pass.
8. **Sidebar.** The navigation component is not in `App.tsx`. It must build its items from the same filtered table. Not reviewed in this pass.

## 5. Session and cookies

Each domain is a separate origin. A user signed in on `SuperchargedAt.Work` is not signed in on `SyncedAt.Work`. This is intended by default. If the two modes must share a login, that is a separate decision that also affects cookie scope and CORS.

## 6. Decisions for review

1. Mode is supplied by the server in the session payload. The client never derives it from the hostname.
2. One bundle, not two builds.
3. The screen mapping in section 3, especially the entries marked decision.
4. Public landing pages: shared, or one per domain.
5. Separate logins per domain (section 5).

## 7. Server-side note (not a client change)

`server/modules/desk-modes/mode-middleware.ts` reads `Host` only. `X-Forwarded-Host` is client-controlled and is never read. The proxy template (`docs/proxy/desk-modes.nginx.conf`) also sets `X-Forwarded-Host` to `$host`, but the middleware ignores that header, so the nginx `X-Forwarded-Host` line is not needed for mode resolution. An nginx change is needed only if the proxy rewrites Host.

## 8. Out of scope

- No client code changes. No change to `routes.ts` or `index.ts`.
- No mounting of the C4 routers. They wait for C3 and C6.
