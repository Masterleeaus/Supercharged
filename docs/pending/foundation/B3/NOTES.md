# B3 lockfile and undeclared dependencies

Status: PROPOSAL. `npm install` was NOT run. package-lock.json is unchanged.

## Changes in package.json.proposed (3 added lines, CRLF kept)
| Package | Proposed range | Locked version now | Used by |
|---|---|---|---|
| nanoid | ^3.3.17 | 3.3.17 (transitive entry in lock) | server/*, client/src/pages/FlowsPage.tsx, FlowBuilderPage.tsx, scripts/ (`import { nanoid } from`) |
| node-fetch | ^2.7.0 | 2.7.0 (transitive entry in lock) | scripts/create-live-policy-flow.ts, setup-live-policy-flow.ts, link-agent-flow-live.ts, test-login.ts (no server import found) |
| @radix-ui/react-visually-hidden | ^1.2.5 | 1.2.5 (transitive entry in lock) | client/src/components/landing/AuthDialog.tsx |

Ranges match the locked versions so resolution does not move. nanoid 3.x is CommonJS-compatible, and the named `nanoid` import is the same in 3.x and 5.x.

## Already declared, missing from lock
- prom-client ^15.1.3 (used via `require('prom-client')` in server/services/metrics.ts)
- safe-regex2 ^5.0.0 (used in server/modules/approvals/approval-service.ts and policy-engine.ts)
These need no package.json change. The lock needs regenerating.

## What `npm install` (or `npm install --package-lock-only`) would change
- Add lock entries for prom-client 15.x and safe-regex2 5.x and their transitive dependencies. Count not verified: I did not query the registry.
- Add direct-dependency entries for the three new ranges to the lock root.
- Possibly re-resolve other ranges if npm dedupes differently. Not verified.
- Until the lock is regenerated, `npm ci` fails because package.json and the lock disagree.

## Decisions for review
- D-B3-1: nanoid ^3.3.17 (keeps the locked version) or ^5 (ESM only, a major change). Proposed: 3.
- D-B3-2: node-fetch in dependencies or devDependencies. Only scripts use it. Proposed: dependencies, since scripts may run on the server.
- D-B3-3: the owner regenerates the lock with `npm install --package-lock-only` and reviews the diff.
