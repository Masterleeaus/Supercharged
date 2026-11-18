# VoltAgent integration docs

Owner of this folder and of `STATUS.md` (VoltAgent section): issue #390.

## Where things are

- Status and what is verified: `STATUS.md`, section "VoltAgent integration".
- Licence gate: `scripts/check-voltagent-licence.mjs`, run as `npm run check:licence`. Runs in CI as job `licence-gate` (`.github/workflows/pr-checks.yml`). Tests: `tests/integrations/voltagent/licence-gate.test.mjs`.
- Mastra attribution: `docs/mastra-attribution.md`.
- Code: `server/integrations/voltagent/`. Flags: `VOLTAGENT_*`, all off by default.
- Tests: `tests/integrations/voltagent/`. Run one file with `node --test --experimental-transform-types <file>`.

## Rules that apply to this integration

- No code is imported from `@mastra/` packages. Mastra source is reference only (`source/mastra-apache-only/`).
- No file under an `ee/` folder is stored, copied or shipped. The licence gate fails the build if one appears.
- Any file copied from Mastra needs its entry in `docs/mastra-attribution.md`, with the Apache-2.0 header kept.
- Nothing is mounted on a public route. Write tools need an approval id that the approval check accepts for that tenant and tool.

## Open decisions for the owner

- Gate G5 (security review): the review is recorded in issue #389 and its PR. The owner decides whether G5 passes.
- Making the `licence-gate` CI job a required check on `main` is a branch protection setting. It is not set by this repo.
