# Supercharged canonical tree map (issue #54, pass 21)

Status: inventory and map only. No code was moved or deleted in this pass. Readiness is not claimed here: a path is "canonical" only in the sense that it is the active source the root build and server entry point use today. Runtime readiness stays with STATUS.md and the per-issue work.

Default decisions (no owner input, recorded in the PR):
- Canonical = the active path that the root build and entry points use today.
- Donor and handoff trees are kept as provenance, not deleted.
- Each capability has one canonical path below. Other copies are listed as donor or archive.

## Counts on main (tracked files, this pass)

| Top-level tree | Tracked files | Role |
| --- | ---: | --- |
| `server/` | 1,507 | Active server, engines, workforce, modules, connectors, integrations |
| `tests/` | 658 | Test suites |
| `client/` | 446 | Browser app |
| `_TITAN_HANDOFF/` | 372 | Donor and handoff collection (provenance only) |
| `docs/` | 98 | Docs; `docs/generated/` holds reports |
| `migrations/` | 73 | SQL migrations (not certified for production; see STATUS.md) |
| `vendor/` | 66 | Third-party or imported content (keep licence notices) |
| `scripts/` | 54 | Build, migration and support scripts |
| `plugins/` | 10 | Plugin adapters |
| `packages/` | 8 | Workspace package (`diploy-core`) |

## Canonical path per capability

| Capability | Canonical path | Other copies or notes |
| --- | --- | --- |
| Browser shell and entry | `client/index.html`, `client/src/App.tsx` | Donor copies are under `_TITAN_HANDOFF/` |
| Login (primary) | `client/src/pages/LoginPage.tsx` | `client/src/pages/Login.tsx` is a legacy copy, still maintained |
| Branding | `client/src/components/BrandingProvider.tsx` | Customer branding from `/api/branding` must not be overwritten |
| HTTP server and routes | `server/index.ts`, `server/routes.ts` | Route auth guards are not changed in this pass (owner decision) |
| Workforce | `server/workforce/` | Gated; not claimed live |
| Decision and payment engines | `server/engines/` | Includes `_template/` scaffold |
| Chatbot | `server/modules/chatbot/` | Draft migrations; see #318 |
| Comms, inbox, marketing | `server/modules/comms/`, `server/modules/inbox/`, `server/modules/marketing/` | Mixed mounted and gated; see STATUS.md |
| Approvals | `server/modules/approvals/` | Migration state tracked in #318 |
| Connectors | `server/connectors/` | Admin health under `server/connectors/admin/` (#353) |
| Integrations (VoltAgent, field-link, titan-*, workforce-runtime) | `server/integrations/` | VoltAgent licence gate: `scripts/check-voltagent-licence.mjs` |
| Plugins | `server/plugins/`, `plugins/` | Donor material under `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/` |
| Schema | `shared/schema.ts` | Central company_id reconciliation tracked in #51 |
| Migrations | `migrations/`, `scripts/run-safe-migration.mjs` | Not safe to certify for production until #34 and #51 |
| Vendor content | `vendor/` | Keep licence and attribution |

## Donor, handoff and archive material kept on purpose

- `_TITAN_HANDOFF/` (372 files): provenance and source manifests. Do not delete until each file is compared with its canonical copy.
- `vendor/` (66 files): imported third-party content with licence notices.
- `docs/archive/` and `docs/generated/` (where present): historical evidence, not instruction sources.

## Not done in this pass

- Full import-graph audit of every donor copy (earlier passes in `docs/SUPERCHARGED_BLOB_DUPLICATION_AUDIT.md` cover part of this).
- Any code move, delete or rename.
- Any change to auth guards or route allowlists.

## Evidence

- Paths in the table above are checked by `tests/scripts/canonical-tree-map.test.mjs`, which fails if a canonical path is missing.
- Counts are from `git ls-files` on main at commit `3c275bef`.
