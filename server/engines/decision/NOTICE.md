# Notice: Decision Engine

The code in `src/` is copied from the Decision Engine repository, which is MIT licensed.

- Source: https://github.com/Masterleeaus/decision-engine
- Source commit: `14a0470` (package version 0.1.0)
- Copyright (c) 2026 Jason Lee
- License: MIT, full text in `LICENSE` in this directory

## What was copied

`src/` holds the source's `index.ts`, `node-shim.d.ts`, and each `engines/<NN>-*/runtime/` and `engines/<NN>-*/tests/` directory, at the same relative paths. The files are byte-identical to the source at commit `14a0470`. Desk-specific glue lives outside `src/`, in `index.ts` and `desk-adapter.ts`.

Not copied: `docs/`, JSON schemas and contracts, `examples/`, `eval-results/`, `scripts/`, and `archive/`. Nothing in the runtime reads those files.
