# Notice: Interaction Engine (offline companion)

- **Copyright holder:** Masterleeaus (Copyright (c) 2026 Masterleeaus. All rights reserved.)
- **Licence:** Proprietary. The full text is the `LICENSE` file in the source repository
  `Masterleeaus/Interaction-engine`, branch `licensing-fix`, commit `d917166`.
- **Use in Desk:** the copyright holder has authorised use of this source in Desk. That
  authorisation is not a licence grant. If Desk is distributed beyond the owner, a written
  licence agreement is needed first (see the LICENSE text).

## What was copied

`offline/` holds `resources/ts/offline/*.ts` from that commit, byte-identical. Nothing was
edited. Not copied: the PHP engine, `dist/`, tests, fixtures and configuration.

## Desk-owned files

- `desk-adapter.ts` (company scoping, injected secret, refusing persistence). This is Desk code.
- Tests: `tests/engines/interaction-adapter.test.mjs`.
