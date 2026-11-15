# Open owner decisions

Date: 2026-11-15
Status: list only. No decision is made here. Each item waits for the owner.

## Count

- Total open decisions: 25
- (a) Blocks production: 3
- (b) Blocks a feature or cleanup: 15
- (c) Can be closed (answered or decided earlier): 7

## How to use this page

Work through one item at a time. Each item gives the question, the options, a recommendation, and what it blocks. Where a brief or PR gives a recommendation, it is copied. Where none exists, the recommendation is marked as a suggestion.

Decision PRs (all drafts, none merged):

- #241 Central decision brief (source for A2, B2 to B6)
- #244 Brand rename (source for B10, B11)
- #245 Widget tenancy brief (source for A3, B7 to B9)
- #246 History removal plan (source for B1)

Not yet on GitHub: the voice provider brief. Branch `claude/sprint-voice-brief` is not on origin, so its file was not read. Its decisions are not listed here.

---

## (a) Blocks production (3)

### A1. Approach for company_id on shared tables

- Question: Which approach adds company_id to every company-owned table?
- Options: The issue does not list options. It asks the owner to choose and log the approach with a date.
- Recommendation: none written. Owner to choose.
- Blocks: #250, #251, #252, #253, #254 and #51.

### A2. Storage for four in-memory records

- Question: Keep the four in-memory stores (processed event ids, processed-event set, single-use nonce ledger, pending sign-ins) in memory, or move them to Postgres?
- Options:
  - Keep in memory. Fine for one staging process only. A restart forgets them, so an event can apply twice and a sign-in in progress is lost.
  - Durable Postgres table, one per store, with the claim in the same transaction as the handler. Needs an additive, reversible migration.
- Recommendation: durable Postgres, before any production use or a second server. Keeping memory is acceptable on staging only if it is written down as a limit. Decide all four together.
- Blocks: #53, #193, #195, #196 (production use).
- Source: #241, decision D3.

### A3. Fix widgets that were created without a company

- Question: May we make new widgets save their company, and fill it in on old widgets?
- Options:
  - Yes, now. This is additive. It stops the 403 on session end and appointment booking for widgets made today.
  - Wait until the full widget decision (B7 to B9) is made.
- Recommendation: yes, now. It needs no product decision.
- Blocks: #127. Live widgets currently fail on session end and booking.
- Source: #245.

---

## (b) Blocks a feature or cleanup (15)

### B1. Remove committed secret files and archives from git history

- Question: Approve rewriting git history to remove six paths, and the force-push that follows?
- Options:
  - Remove only the two secret files (required by #2).
  - Remove all six: the two secret files, plus two zip archives, a third zip and a log (recommended by #133).
  - Rewrite every branch, or only main. The plan says every branch.
- Recommendation: remove all six and rewrite every branch, as the plan says. Run the content scan first. It has not been run yet.
- Blocks: #133 (history part), #2 (step 4, only if the repo is shared outside the team). The 17 open PRs must be rebased after.
- Source: #246.

### B2. Signature check for Central outbox events (D1)

- Question: Which signature check do Central events use?
- Options:
  - A: HMAC over the raw body, header `t=<unix>,v0=<hex>`.
  - B: HMAC over the canonical JSON of the envelope (sorted keys, signature removed).
- Recommendation: B, but only if Central's signer or its EVENTS.md confirms canonical JSON. Keep one verifier, not two.
- Blocks: #53, #193, #195, #196.
- Source: #241, D1.

### B3. Feature flag reader (D2)

- Question: Which flag reader do we keep?
- Options:
  - A: read a local snapshot. Nothing creates the snapshot today.
  - B: call Central's flag endpoint, 1 second timeout, 60 second cache, default on failure.
- Recommendation: B. The endpoint path in code is assumed, not checked against live Central.
- Blocks: #53, #196.
- Source: #241, D2.

### B4. Membership check: live or cached (D4)

- Question: Ask Central on every request, or cache membership?
- Options:
  - A: ask Central every time. Revocation is immediate. Users are locked out if Central is down.
  - B: cache membership with a maximum age. Users keep working through a short outage. Revocation takes effect after the age limit.
- Recommendation: B, with a 5 minute limit as a start (suggested). Fail closed after the limit. The limit is the owner's value.
- Blocks: #195.
- Source: #241, D4.

### B5. Which token claim holds the company id (D5)

- Question: Which claim name carries the company id?
- Options:
  - A: the claim name Central declares in its contract.
  - B: a name agreed with the Central operator, separate from the org claim.
- Recommendation: A. Confirm the exact name with the Central operator. Do not add a default in code.
- Blocks: #195 and staging sign-in tests.
- Source: #241, D5.

### B6. Which config names to keep (D6)

- Question: Which set of sign-in config names do we keep?
- Options:
  - `central-sso` names: `CENTRAL_OIDC_ISSUER`, `CENTRAL_OIDC_CLIENT_ID`, `CENTRAL_OIDC_CLIENT_SECRET`.
  - `central-oidc` names: `CENTRAL_ORIGIN`, `TITAN_DESK_OIDC_CLIENT_ID`, `TITAN_DESK_OIDC_CLIENT_SECRET`.
- Recommendation: keep the `central-sso` names. Retire the other set together with B2 and B3.
- Blocks: #53, #193.
- Source: #241, D6.

### B7. Should widgets belong to a company

- Question: Should website widgets belong to a company instead of one user?
- Options:
  - A: company scope. Add a migration, back-fill, and filter the dashboard by company.
  - B: keep user scope and accept the gap. New widgets keep failing on the public side.
- Recommendation: A, in two parts. Part 1 is A3. Part 2 waits for B8 and B9.
- Blocks: #127.
- Source: #245.

### B8. Which company a widget uses when a user has several

- Question: When a user belongs to several companies, which company does a widget get?
- Options: the user's primary company (`users.company_id`), or ask on each request.
- Recommendation: the primary company (suggested default in #245).
- Blocks: #127 part 2.
- Source: #245.

### B9. Can other people in the same company see widgets

- Question: Can other users in the same company see and edit a company's widgets?
- Options:
  - Everyone in the company can see and edit. Admins only can delete.
  - Only the owner user can see and edit (today's behaviour).
- Recommendation: everyone in the company sees and edits; only admins delete (suggested default in #245).
- Blocks: #127 part 2.
- Source: #245.

### B10. Package name `agentlabs`

- Question: Rename the package from `agentlabs` to Supercharged?
- Options:
  - Keep `agentlabs`. pm2 and install docs depend on it.
  - Rename, and update pm2 and install docs in the same change.
- Recommendation: keep it until pm2 and install docs can change together (suggested). #244 leaves this as an owner decision.
- Blocks: #54 and PR #244.
- Source: #244.

### B11. Keep vendor name and copyright text

- Question: Keep the Diploy and Envato copyright headers, the `Diploy - AgentLabs` notice, and the storage keys and DOM prefixes as they are?
- Options: keep them (as #244 does), or change them.
- Recommendation: keep. They are legal attribution or compatibility. Owner to confirm.
- Blocks: #54, #37 and PR #244.
- Source: #244.

### B12. Voice credit rate (O-05)

- Question: What is the voice credit rate?
- Options: the owner gives the value. It lives in the external Entity driver, not in this repo.
- Recommendation: none. Set it before voice billing is turned on.
- Blocks: the voice feature in #26.

### B13. Cal.com list-bookings API version (O-10)

- Question: Is `2026-05-01` the correct Cal.com version?
- Options: confirm it, or give the right version. No official source in the repo confirms it. Create and cancel have the same gap.
- Recommendation: owner checks Cal.com's current docs and confirms (suggested).
- Blocks: Cal.com list, create and cancel in #26.

### B14. Public webhook URL (O-24)

- Question: What is the public webhook URL?
- Options: confirm one URL, or give a different one.
- Recommendation: confirm before any provider is set up.
- Blocks: channel providers in #22, #24 and #26.

### B15. Human-agent rule (`hasHumanAgents`)

- Question: Does `hasHumanAgents` mean an active agent-role user? Which plan field should be added?
- Options: confirm the definition as written, or change it.
- Recommendation: confirm it, and add the plan field when one exists.
- Blocks: chatbot handoff to a human in #26.

---

## (c) Can be closed (7)

These are answered or decided earlier. The owner closes each issue.

- C1. #2 webhook secrets. Owner confirmed the secrets are rotated (answered 2026-11-15). Close after the change that stops tracking the files is merged. The history part is B1.
- C2. #26 demo call cap. Stays at 30 seconds (answered 2026-11-15). Close this item.
- C3. #51 split. Split into #250 to #254 (answered 2026-11-15). #51 can be closed as the parent. The company_id approach is still A1.
- C4. Chatbot tables get row-level security (answered 2026-11-15). Link to #251 (RLS migrations).
- C5. #130 membership table or company_id column. Decided earlier. The chosen option is not written in the issue. Owner to add it there, then close.
- C6. #131 unnumbered `add_missing_columns.sql`. Decided earlier. Same gap. Owner to add the choice to the issue, then close.
- C7. #132 database for the boot check. Decided earlier. Same gap. Owner to add the choice to the issue, then close.

---

## Not in this list

- Checks listed in #26 (channel webhooks against real providers, full boot with a database, full `tsc`) are tasks, not decisions.
- Vertical audits (#168 to #176) and code-quality items (#15, #17, #122, #129) have no owner decision in their text.
