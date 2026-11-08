# tsconfig.json (DRAFT) notes

The root `tsconfig.json` is a DRAFT. It was inferred from the code and was not restored from source. No original tsconfig was found in this copy (see `docs/WORKFORCE_RUNTIME.md`, which says the copy has none).

Inferred from:
- Path aliases: `@shared/*` (used as `@shared/schema` in 130 files under server, shared and tests, resolving to `shared/schema.ts`) and `@/*` (used in 200 files under `client/src`, resolving to `client/src/*`, e.g. `@/i18n` to `client/src/i18n/index.ts`).
- `allowImportingTsExtensions`: workforce and other server code imports `.ts` paths directly (about 397 relative `.ts` imports), so `noEmit` is set.
- `module` ESNext with `moduleResolution` Bundler: needed for `allowImportingTsExtensions` under TypeScript 5.6.3 (the pinned version in `package.json`).
- `jsx` react-jsx: client code is `.tsx`.
- `strict` false: not inferred from code; the code does not show strict-mode patterns. This is a guess.
- `include` and `exclude`: guessed from the directory layout.
- `types` ["node"]: guessed from the server code.

Not verified: `tsc` was not run, so the draft has not been checked against the code.
