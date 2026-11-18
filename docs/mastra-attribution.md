# Mastra attribution

Status: records the licence position for the VoltAgent and Mastra work on this repository. Owner of this file: the VoltAgent docs owner (issue #390).

## Position

- No Mastra source code is copied into `server/` or `tests/`. Every file under `server/integrations/voltagent/` says it is original TitanZero code. Where an adapter ports a Mastra idea, the file names the gap it closes and states that no Mastra code is copied.
- The reference snapshot in `source/mastra-apache-only/` holds only Apache-2.0 files from Mastra. It is reference material. Do not import from it.
- No `@mastra/*` import exists in tracked code. `scripts/check-voltagent-licence.mjs` (`npm run check:licence`) fails the build if one appears, or if a tracked path under an `ee/` folder appears.
- `MASTRA_LICENSE_KEY` must never be set. Mastra core checks for it.

## If Apache-2.0 code is copied later

1. Copy only the named file or function. Keep its original copyright and Apache header.
2. Add a row to the table below with the source path, the upstream commit or snapshot date, and the local file that holds the copy.
3. Add a note at the top of the local file that names the upstream source and the licence.
4. Re-run `npm run check:licence`.

## Copy record

| Local file | Upstream source | Copied code | Date |
| --- | --- | --- | --- |
| (none) | (none) | No Mastra code copied to date | 2026-11-18 |

## Source

- Snapshot: `source/mastra-apache-only/README.md` (Apache-2.0 files only, `ee/` removed).
- Copyright line as stated in that README: Copyright (c) 2025 Kepler Software, Inc. Apache-2.0 files keep their original headers.
