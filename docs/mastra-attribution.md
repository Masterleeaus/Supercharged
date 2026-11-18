# Mastra attribution and boundary

Scope: what the repo says about Mastra-derived code. Owner: the VoltAgent integration owner (see `docs/voltagent/README.md`).

## Boundary, enforced in code

- `server/integrations/` must not import from `@mastra/`. Enforced by `scripts/check-voltagent-licence.mjs` (`npm run check:licence`).
- `server/integrations/` and `tests/integrations/` must not contain `/ee/` paths. Enforced by the same script.

## Status

- [verified] The licence gate exists and is wired as `npm run check:licence`.
- [untested] Whether the gate passes on this branch. Run `npm run check:licence` before relying on it.
- No Mastra code is listed in this repo's integration tree as of 18 November 2026.

## Attribution

If any file is ported from Mastra or another upstream project, add its name, the source path, the licence, and the commit it was taken from to this file in the same PR.
