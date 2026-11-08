# Agent rules (desk-review)

Read this file first, then your brief. Repo: /home/claude/desk-review (Node 22, TypeScript, Express, Drizzle, React client).

## Commands
- Run narrow tests only, the files you own plus tests your change affects: `node --test --experimental-transform-types <files>`.
- Never run full `tsc` (8 GB machine, out of memory). Never run full `npm test`. No `npm install`, no `npm audit fix`.
- No migrations. Do not apply any DRAFT_*.sql to a database. You may create new DRAFT files in migrations/ (they must include a guard line so they cannot run by accident).
- No live database, network calls or real provider calls in tests. Use fakes.
- Test files must not write to stdout. Silence console.log/info/warn at the top of any test file that imports server code, otherwise the test runner's IPC breaks.

## File ownership
- Edit only the files listed in your brief. Creating new files is allowed when your brief says so.
- Never edit: server/routes.ts, server/workforce/runtime/compose.ts, server/workforce/runtime/scheduler.ts, tests/infrastructure/**, docs/**, client/src/App.tsx, or the checklist files in /home/claude.
- If you need a change in a file you do not own, do not make it. Put it in CHANGES_NEEDED with file, location and the exact change. Claude applies it.
- A new route must be a new file exporting a factory `createXRouter(deps, guards)`. Guards (authenticate, requireCompanyScope, requireRole) are injected, not imported. Put the exact mount line in MOUNTS_NEEDED.

## Security and tenancy
- Company comes from the verified session (res.locals.companyId, set by requireCompanyScope). Never from request body, query or params.
- Fail closed: when company, role or config is missing, refuse. Never guess a tenant.
- Never paste, log or hard-code keys, tokens or secrets. Use fake values in tests.
- Errors returned to clients must be generic. No stack traces, no provider payloads.

## Decisions
- Do not ask Jason questions. Choose the safest default that fails closed and list it under DECISIONS. Claude will raise anything Jason must decide.

## Report format (under 250 words, no preamble)
DONE: <checklist ids you fully finished>
PARTIAL: <ids and what remains>
BLOCKED: <ids and why>
FILES: <list of files changed or created>
TESTS: <file: pass/fail counts>
MOUNTS_NEEDED: <exact lines for routes.ts, or none>
CHANGES_NEEDED: <file, location, exact change, or none>
DECISIONS: <defaults you chose>
