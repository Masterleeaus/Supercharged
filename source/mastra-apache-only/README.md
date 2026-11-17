# Mastra, Apache-2.0 files only

Reference snapshot of Mastra (https://github.com/mastra-ai/mastra). Snapshot taken 2026-11-18 from mastra-main.zip.

## What is in the zip

- Everything outside the directories named ee/, under the Apache License 2.0. The licence text is in mastra-main/LICENSE.md.
- All 172 files under ee/ folders have been removed. Those are under the Mastra Enterprise Edition License, which forbids production use without an agreement and forbids redistribution. They must not be stored or shipped from this repository.

## Limits

- This snapshot does not build on its own. Three non-test core files reference enterprise types (packages/core/src/server/types.ts, agent/durable/types.ts, mcp/types.ts).
- It is reference material only. Do not import from it into the app. Copy only the specific Apache files we need, with attribution, as described in docs/mastra-attribution.md.
- Do not set MASTRA_LICENSE_KEY anywhere. Any Mastra package in use loads core, which includes an enterprise licence check that is inactive without that key.

## Attribution

Copyright (c) 2025 Kepler Software, Inc. Apache-2.0 files keep their original headers.
