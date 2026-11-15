# Test triage: main at 749b7bb (2026-11-15)

Run: `pnpm install`, then `pnpm test` (`node --test --experimental-transform-types $(find tests -name '*.test.*')`) on a fresh clone of `main` at `749b7bb`.

## Totals

| Metric  | Count |
|---------|-------|
| Tests   | 7009  |
| Pass    | 6945  |
| Fail    | 3     |
| Skipped | 61    |
| Suites  | 8     |
| Duration | about 436 s |

## Failures by category

| Category | Count | Tests |
|----------|-------|-------|
| Broken by an in-flight PR | 0 | none |
| Pre-existing (test expectation drift on main) | 1 | pool and spa servicing is served by pool roles |
| Environment-only (needs a Postgres service) | 2 | outbox on the local harness database; every chatbot draft applies to a fresh database |
| Real bug | 0 | none |

No GitHub issues were opened, because no failure is a real bug.

## Details

### 1. Environment-only: outbox on the local harness database

- File: `tests/modules/chatbot-channels.test.mjs:569`
- Error: `role "pgtest" does not exist` (SQLSTATE 28000)
- Cause: the test sees a listener on `127.0.0.1:55432` and runs, but the cluster has no `pgtest` role. The setup script `server/modules/chatbot/db/harness/pg-local.sh` runs `initdb -U pgtest` to create that role, so the cluster was not provisioned by that script. The test needs a correctly initialized local Postgres.
- Action: none in the repo. Start the harness with `pg-local.sh reset` on a machine that is allowed to run it, then re-run.

### 2. Environment-only: every chatbot draft applies to a fresh database

- File: `tests/modules/chatbot-db/harness.test.mjs:37`
- Error: `harness exited 1`, then `role "pgtest" does not exist`
- Cause: same as item 1. The harness connects as `postgres://pgtest@127.0.0.1:55432/postgres`.
- Action: same as item 1.

### 3. Pre-existing: pool and spa servicing is served by pool roles

- File: `tests/workforce/roles-landscaping-pool-spa.test.mjs:31`
- Error: `9 !== 8` (the test expects exactly 8 roles whose `verticals` include `pool`)
- Cause: the catalogue now has 9 pool roles. The extra one is `server/workforce/catalogue/roles/go-manager.ts`, which lists `pool` among its verticals. It was added in `befc8ee` ("Add named Hub, Go and Command Managers..."), which is an ancestor of `main`. The exact count in the test was not updated.
- Judgment call: this looks like stale test data, not a product defect. The Go Manager role covering pool jobs is consistent with its description. If `go-manager` should not cover `pool`, that is a catalogue fix instead. Owner to confirm.
- Action: either update the expected count to 9, or assert on the specific pool roles that must exist.

## Other findings

- The repo has `package-lock.json` and no `pnpm-lock.yaml`. `pnpm install` therefore resolved from `package-lock.json` and generated a new `pnpm-lock.yaml`, which was not committed. Installs are not reproducible from a committed pnpm lockfile.
- 61 tests are skipped. These were not triaged, because they do not fail.
- Open PRs were checked by file list (`gh api repos/Masterleeaus/supercharged/pulls/<n>/files`). None touch `server/workforce/catalogue/roles/`, the pool role test, or the chatbot harness, so none of the three failures comes from an in-flight PR.
