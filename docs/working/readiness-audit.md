# Readiness audit (2026-11-15)

Read-only audit of open issues and open PRs against main (41d034a).

## Counts

- Open issues: 30
- Vertical issues (not checked per issue): 8
- Non-vertical open issues: 22
- (a) Closable now: 0
- (b) In review (draft code PR open): 12
- (c) Owner-blocked: 9
- (d) No work started: 1

## Notes on the source docs

- docs/canonical/ does not exist on main. CLAUDE.md names it, but the files are missing.
- docs/canonical/ROADMAP.md is not on main, and no "Definition of finished" section was found in docs/generated or docs/working.
- So the roadmap comparison could not be done. This audit compares issues and open PRs only.

## (a) Closable now

- None verified. Issue #133 is partly done on main (no tracked zip, tar or log files; .gitignore has *.zip and *.log), but the history cleanup is still open. It is listed under (c).

## (b) In review (draft PR open, not merged)

- #15 typing debt: PR #229
- #17 split routes: PR #235
- #19 reminder webhook trigger: PR #223
- #22 widget and channel reply runtime: PR #231
- #24 voice-call service at boot: PR #225
- #26 chatbot owner open items: PR #230 (also #227). Label is decision-needed, so the owner must answer open items too.
- #48 Synced chatbot builder mode: PR #230
- #54 rebrand: PR #244 (also #227)
- #122 typecheck required, client pages: PR #243
- #127 tenant isolation, every module: PRs #228, #240, #242 (code). PR #245 is a decision brief and is listed under (c) as well.
- #129 break up largest client pages: PR #233
- #197 verify shared PostgreSQL and tenant bounds: PR #239 (tests only). Depends on Central decisions in (c).

## (c) Owner-blocked

Each item below needs the owner to answer the exact question before work can continue.

- #2 committed webhook secrets: Do you approve the history rewrite in PR #246 (remove 2 secret files from git history, force-push, then rotate the webhook secrets)?
- #133 committed archives and logs: Same decision as #2. Do you approve the history rewrite in PR #246 for the 4 archives and logs?
- #130 membership table or company_id column: Which should users in several companies use, a membership table or a company_id column?
- #131 unnumbered add_missing_columns.sql: Include it in migrations or drop it?
- #132 boot check database: PGlite or native Postgres?
- #127 widget tenancy: Do you approve the additive change in PR #245 that sets and backfills company_id on widgets?
- #53, #193, #195, #196 Central integration: Do you approve the Central decisions in the brief in PR #241 (sign-in adapter, tenant model, feature flags and outbox)?

## (d) No work started

- #51 move onto shared company_id schema and Central migration chain. No PR. It depends on #130 and the Central items in (c).

## Excluded

- Vertical issues: #168, #170, #171, #172, #173, #175, #176, #186. Not checked per issue, per the lane rules.
