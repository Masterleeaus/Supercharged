# VoltAgent integration: docs owner

Owner of this folder: the VoltAgent integration owner. Also owner of `STATUS.md` (VoltAgent section) and `docs/mastra-attribution.md`. Change these in the same PR as the code they describe.

## Current state (Phase 0, 18 November 2026)

- Pins: seven `@voltagent` packages at exact versions (package.json).
- Guard: `assertNoVoltOpsKeys` refuses to boot if `VOLTAGENT_PUBLIC_KEY` or `VOLTAGENT_SECRET_KEY` is set.
- Flags: nine `VOLTAGENT_*` flags, all off by default. Nothing is mounted.
- Licence gate: `npm run check:licence` runs `scripts/check-voltagent-licence.mjs`. It fails on any tracked `/ee/` path under `server/integrations/` or `tests/integrations/`, and on any `@mastra/` import under `server/integrations/`.

## Rules

1. Do not mark a capability as working in STATUS.md until a test or a boot check shows it.
2. Any new VoltAgent code goes under `server/integrations/voltagent/`. Run the licence gate before merging.
3. Secrets are read from `.env` only. Never commit VoltOps keys.

## Files this owner keeps

- `STATUS.md` (VoltAgent section)
- `docs/voltagent/README.md` (this file)
- `docs/mastra-attribution.md`
