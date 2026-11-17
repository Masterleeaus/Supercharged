# Source snapshots

Reference copies of third-party source. Used for reading and for copying permitted code. Not built or run by the app.

## voltagent-main.zip

- Project: VoltAgent (https://github.com/VoltAgent/voltagent)
- Licence: MIT. The licence text is inside the zip at voltagent-main/LICENCE.
- Snapshot: uploaded to this repo on 2026-11-18. Core package version 2.11.1 in the snapshot.
- Contains no enterprise-licensed folders (checked: no ee/ paths, no licence-key checks).

## Not included

- Mastra source. It contains 172 files under ee/ folders, which are under the Mastra Enterprise Edition License. That licence forbids redistribution, and this repository is public, so Mastra source is not stored here. Only the Apache-2.0 code we copy will be added, with attribution, as described in docs/mastra-attribution.md.
- Langfuse source. It also contains enterprise-licensed folders, for the same reason.
