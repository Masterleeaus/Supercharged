# Chatbot builder routes: decisions

Status: built and tested in isolation. Not mounted, not wired to a database, not type-checked. A Drizzle storage exists (see the Drizzle section) but no route uses it yet.

Files: `builder-router.ts`, `builder-schemas.ts`, `builder-storage.ts`, `schema.DRAFT.ts`, and `../db/builder.ts` (Drizzle fragment). Contract: `endpoint-map.md`. Tests: `tests/modules/chatbot-builder-routes.test.mjs` (36 of 36 pass), `tests/modules/chatbot-builder-drizzle.test.mjs` (14 of 14 pass).

## Decisions for the owner to review

1. **Off by default.** Every route answers 404 unless `ENABLE_CHATBOT_BUILDER_ROUTES` is exactly `"true"`. The flag is checked before authentication, the same as the booking router.

2. **Not mounted.** To turn this on, mount it under `/api/chatbot` after `authenticateToken` and `requireCompanyScope`, and pass a real `BuilderStorage`. Nothing in `routes.ts` or `index.ts` changed. `STATUS.md` should get a line when this is mounted.

3. **Database storage is written, not promoted.** `DrizzleBuilderStorage` exists (see the Drizzle section). No migration is applied, and the builder columns are not yet in `shared/schema.ts`.

4. **Storage shape differs from the contract's names.** `endpoint-map.md` lists `findChatbot`, `findBuilderSettings`, `updateChatbot` and `updateBuilderSettings`. This code uses `findBuilderState` and `updateBuilderState`. One call writes the five classic columns and the settings JSON together, so the "one transaction" rule holds by construction. The Drizzle version must run that call in one transaction.

5. **External routes return 501.** `POST /builder/avatars` and `POST /builder/:id/uploads` answer `{ error: "not_implemented", reason }`. Neither can work without a multipart parser and a file store. The upload route still checks that the chatbot belongs to the caller first, so a cross-company id gets 404, not 501.

6. **Upload checks are deferred.** The contract asks for a 400 on a bad `kind` and a 413 or 415 on bad files. Those cannot run until the multipart parser is wired. `multer` is already in `package.json`, but I did not wire it.

7. **Image paths are locked to the company.** Chatbot image fields (logo, welcome background, header image, promo banner) must start with `/uploads/chatbot/<companyId>/` and end in a plain file name with no dots run or slashes. The avatar must be a preset or one of this company's uploads, checked against storage.

8. **Gradient values are restricted.** Must start with `linear-gradient(` or `radial-gradient(`. Characters `< > { } ; " ' ` \` are rejected, because the value is written into a style attribute.

9. **Trusted domains are normalised.** Lower-cased, protocol and trailing slashes removed, duplicates dropped, at most 50. Each must be a hostname with an optional port. A path is rejected.

10. **FIXED (finding M4).** A save now requires welcome message, bubble message, and instructions outside demo mode, the same fields PHP's `ChatbotStoreRequest` requires. See the M4 section below.

11. **Empty PATCH is 400.** At least one group must be present. The contract is silent on this.

12. **Links accept null, empty, or an http or https URL** up to 2048 characters.

13. **Suggested prompts need text.** Name and prompt are trimmed and must be at least one character. The contract gave only maximum lengths.

14. **Roles match the chatbot routes.** Reads: admin, manager, agent. Writes and uploads: admin, manager. `requireRole` is a required dependency with no allow-all default. The booking router defaults to allow-all; I did not copy that.

15. **Body limit is 256 KB** for PATCH. Sized for the contract maxima with multi-byte text.

16. **Read responses fill gaps.** Null welcome message and instructions come back as `""`. Keys never saved come back as the wizard defaults in `EMPTY_WIZARD_STATE`.

17. **Transparent trigger is stored as a boolean** (`transparentTrigger`), as the contract says. The core `"transparent"` string is not produced, because no core database is involved.

18. **Limits and enums are copied, not imported.** They mirror `client/src/pages/chatbot-builder/types.ts`. If one side changes, change the other.

## How the tests were run

- express and zod are not installed in this repo (`node_modules` is absent).
- I installed express 4.22.1 and zod 3.24.2, the versions in `package.json`, outside the repo at `/home/claude/builder-test-deps`.
- A preload hook (`/home/claude/builder-test-deps/register.mjs`) maps the two bare imports to that folder.
- Command for the in-memory route tests after the Drizzle change. These need drizzle-orm, so the integration scratch hook is used. It maps express, zod, drizzle-orm, drizzle-zod and pg:

```
NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" \
  node --test --experimental-transform-types tests/modules/chatbot-builder-routes.test.mjs
```

- Under `/home/claude/builder-test-deps/register.mjs` alone the route tests fail with `Cannot find package 'drizzle-orm'`, because `builder-storage.ts` now imports Drizzle. Adding drizzle-orm 0.45.2 to that folder would fix it. That folder is outside this slice, so it was not changed.
- The existing booking test also passes under the builder-test-deps hook (21 of 21).

## Not done

- **No type-check.** The repo's `CLAUDE.md` forbids a full `tsc` on this 8 GB machine, and no narrow check was run.
- **Checklist not updated.** `CLAUDE.md` asks that behaviour-changing decisions go in `/home/claude/supercharged-fixes-checklist.md`. That file is outside this agent's write scope, so the entries above need adding by the main session.
- **No public widget runtime.** The embed snippet's `uuid` is returned, but nothing serves the widget script yet.
- **Avatar `url` equals `path`** in the in-memory store. The real URL depends on the file store.

## Drizzle

Date: 2026-11-08. Scope: builder columns and avatars only. Nothing else in the chatbot module changed.

1. **Storage is Drizzle.** `DrizzleBuilderStorage` in `builder-storage.ts` implements the same `BuilderStorage` interface as the in-memory version. The interface did not change.

2. **Tables.** The builder columns (`builder_settings` jsonb, `public_uuid` uuid) are in the fragment `server/modules/chatbot/db/builder.ts`. The classic columns come from `chatbots` in `shared/schema.ts`. `shared/schema.ts` was not edited. The avatars table is `chatbot_avatars`, defined in the same fragment file.

3. **Join in code.** The builder columns are read through `chatbotBuilderTable`, filtered by the parent's `id` and `company_id`. There is no database foreign key between the two definitions, since both map the same `chatbots` table.

4. **Two definitions of `chatbots` in code.** `chatbotBuilderTable` in `db/builder.ts` maps the same SQL table as `shared/schema.ts`, so the builder storage can reach the two new columns. The owner merges by spreading `builderChatbotColumns` into the promoted `chatbots` definition and deleting `chatbotBuilderTable`. Until then, two pgTable objects share one name. Keep only one in any drizzle-kit schema index.

5. **Atomic write.** `updateBuilderState` runs the classic-column update and the settings merge in one `db.transaction`. If the chatbot is not in the company, the transaction stops after the first update, and nothing else is written (UNVERIFIED against Postgres).

6. **Settings merge is a jsonb merge in SQL.** The write uses `builder_settings || $1::jsonb`, so keys not in the patch are kept and the stored object is never read, changed, and written back. Top-level keys in the patch replace the stored value, so `trustedDomains` as a whole array replaces the old list.

7. **Company scope.** Every statement filters by `company_id`. Avatars list presets (`company_id is null`) and this company's uploads only. The company id is the first argument of every method, as before.

8. **Avatars keep a nullable company_id.** A null value marks a preset shared by every company. Every other table has `company_id not null`.

9. **Not promoted.** No migration. No route calls `DrizzleBuilderStorage` yet. The mount still needs a storage passed in by the owner.

10. **Tests without a database.** Statements are built with `drizzle.mock()` and rendered with `PgDialect.sqlToQuery`. The tests check each one has a `company_id` predicate and that company A's id is in the params and company B's is not. One stub test covers the transaction stop. The transaction and read-back paths are not run against Postgres. That needs a real database test once one exists.

## M4 (save validation): FIXED

Source: `integration/VERIFICATION.md`, finding M4.

- A save now requires the same fields PHP's `ChatbotStoreRequest` requires: welcome message, bubble message, and instructions outside demo mode. Blank and whitespace-only text count as missing, as Laravel's `required` treats them.
- The request shape stays partial, so a PATCH with a single key still works. The check runs on the state the patch would leave behind: stored values, replaced by any value in the patch. This is `saveIssues` in `builder-schemas.ts`. The router reads the stored state first and returns 400 with issues before any write.
- Demo mode is a dependency, `demoMode`, defaulting to `false`, so instructions are required unless the caller says otherwise. `integration/mount.ts` does not pass it yet. Nothing in this slice reads an environment variable for it.
- Behaviour change: a chatbot with no stored bubble message cannot be patched until one is sent, even for an unrelated key such as colour. An earlier note in this file (decision 10, now FIXED) says the client requires all four fields on save. I did not re-check the client, so confirm the wizard does not send partial saves on a new chatbot. Tell me if partial saves on incomplete chatbots should be allowed instead.
- Known gap: the stored state is read, then written. Two saves at the same moment could each pass the check. Fixing it needs a row lock taken before the check, inside the transaction. The storage interface does not allow that yet.
- Title is not added to the save rule. It is still required only when sent.
- Tests: `tests/modules/chatbot-builder-routes.test.mjs` adds nine tests (save rule, demo mode, the unit function, and the default demo flag). The seeded chatbot now carries a bubble message by default.

## Integration fix 7 (2026-11-08)

- The second `chatbots` table in `db/builder.ts` (`chatbotBuilderTable`) is removed. Item 4 above is resolved. The builder storage reads `builder_settings` and `public_uuid` as SQL identifiers on the shared `chatbots` table in `shared/schema.ts`, and writes the settings merge as a raw `update`. Both stay until the owner promotes `builderChatbotColumns`, which then replaces the raw SQL.
- The root `server/modules/chatbot/schema.DRAFT.ts` re-exports the shared `chatbots` table instead of defining its own.
- Test: `tests/modules/chatbot-builder-drizzle.test.mjs` (14 of 14 pass).
