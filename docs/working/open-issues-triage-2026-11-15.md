# Open issue triage, 2026-11-15

Scope: the 83 open issues in Masterleeaus/Supercharged at the start of this pass
(PRs excluded). Evidence was checked against main at 31683bd and against the open
PRs listed below. Narrow tests were run on main for the closure evidence.

## Result

- Closed with evidence: 21
- Left open, linked to an open PR (comment added with the PR number): 44
- Implemented in this pass: 0 (no remaining issue is small, uncovered and clearly
  specified; see the last section)
- Left open, no PR covers it: 18

## Closed with evidence

- Cleaning verticals 1 to 10 (#137 to #146): merged PR #217.
- Central link assertions and service client (#135, #192, #194): merged PR #214.
- Central company mapping (#134): merged PRs #103 and #211.
- Flow TODOs (#18): TODOs are gone on main; merged PR #220.
- Licence (#37): merged PRs #203 and #204.
- Named Hub, Go, Command and Skilled managers (#49, #50): merged PR #218.
- Boot check on fresh PostgreSQL (#124): merged PR #219.
- Secret scan gate in CI (#125): secret-scan job in .github/workflows/pr-checks.yml.
- CI baseline (#136): .github/workflows/pr-checks.yml and merged PR #219.

## Open, linked to an open PR (not merged yet)

- Verticals 11 to 20 (#147 to #156): draft PR #213.
- Verticals 21 to 30 (#157 to #166): draft PR #212.
- Verticals 31 to 40 (#167 to #176): draft PR #210.
- Verticals 41 to 50 (#177 to #186): draft PR #216.
- Central OIDC sign-in (#193), tenant model (#195), flags and signed events (#196),
  Central sign-in adapter (#53): PR #221 is open. It has no code exchange or
  handoff yet, which needs a Central handoff contract.

## Open, no PR covers it

- Owner decisions recorded in code, waiting for owner confirmation:
  - #130 membership table (migrations/0017_user_company_memberships.sql, PR #208).
  - #131 unnumbered migration dropped (PR #208).
  - #132 native PostgreSQL 16 for the boot check (PR #219).
- Security:
  - #2 webhook secrets: not tracked on main, but the history still has them.
    Rotation and any history purge are owner actions.
  - #133 archives and logs: removed from the tree. Triage of candidate secret
    hits in three archives is still open (owner, under #125).
- Code quality:
  - #15 explicit any: about 43 removed in server/services (PR #220). The rest is open.
  - #17 route file size: routes.ts and flow-automation-routes.ts are split, but
    many route files are still above 800 lines.
  - #129 large client pages: not started.
- Tenancy and release:
  - #51 company_id schema and registry: partly done (PR #208). Full inventory open.
  - #127 tenant checks for every module: only Marketing and Inbox, plus memberships.
  - #122 required typecheck: nine areas pass. Other areas still fail, and making
    the check required is a branch-protection change.
  - #197 AI Workforce verification on shared PostgreSQL: needs a real environment.
- Product:
  - #19 reminder_sent flow trigger: no event-to-flow trigger mechanism exists (PR #206).
  - #22 channel reply runtime, #24 voice call service: blocked on owner decisions (PR #206).
  - #26 owner open items O-05, O-10, O-24, demo limit, human-agent rule: owner decisions.
  - #48 customer chatbot builder: needs an owner scope decision.
  - #54 rebrand and source consolidation: names done (PR #218), consolidation not.

## Decisions made in this pass

- Closed issues only where a merged PR or a file on main is named as evidence, and a
  narrow test was run on main when the claim was about code behaviour.
- Decision issues #130, #131 and #132 were not closed. Their done-when asks the
  owner to record the choice, so each has a comment naming the decision taken.
- No code was written in this pass. Every remaining issue is either covered by an
  open PR, blocked on an owner decision or an external system, or large enough to
  need its own lane.
- PR #207 (draft) duplicates the link-assertion work already merged in PR #214, on a
  different path. It was not closed here, because it is another lane's PR.
