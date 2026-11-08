# Vendored from Titan Zero Field

These files are copied unchanged from the canonical Field repository. Do not edit them here. To update, copy again from the source at the commit below and record the new hash.

- Source repository: https://github.com/Masterleeaus/titan-zero-field-service-workforce
- Source commit: b6fed9da4ab411dc8f147b30e418854e015b216c (output of `git rev-parse HEAD` in the source clone, 2026-10-08 commit)
- Licence file: none. The Field repository root has no LICENSE, COPYING or licence field in package.json. The only LICENSE file in that repo is under `apps/browser/imports/`, which is not vendored here. Licence terms were not analysed.

## Files and source paths

| Vendored path | Source path in Field repo |
|---|---|
| `workforce-native/contracts.ts` | `packages/titan-platform/src/workforce-native/contracts.ts` |
| `authority/runtime-authority-gateway.mjs` | `packages/runtime/authority/runtime-authority-gateway.mjs` |
| `authority/authority-evaluator.mjs` | `packages/runtime/authority/authority-evaluator.mjs` |
| `authority/authority-lease.mjs` | `packages/runtime/authority/authority-lease.mjs` |
| `authority/autonomy.mjs` | `packages/runtime/authority/autonomy.mjs` |
| `authority/company-boundary.mjs` | `packages/runtime/authority/company-boundary.mjs` |
| `authority/delegation.mjs` | `packages/runtime/authority/delegation.mjs` |
| `authority/history-integrity.mjs` | `packages/runtime/authority/history-integrity.mjs` |
| `authority/lease-control.mjs` | `packages/runtime/authority/lease-control.mjs` |
| `authority/protected-actions.mjs` | `packages/runtime/authority/protected-actions.mjs` |
| `authority/worker-authority.mjs` | `packages/runtime/authority/worker-authority.mjs` |

The gateway imports `authority-evaluator.mjs`, which pulls in the other `authority/` files listed above. Those are the full local import closure of the gateway. Its tests (`runtime-authority-gateway.test.mjs`) were not copied.

The task brief referred to `services/workforce` for these files. The contracts and gateway actually live under `packages/`, as listed above.
