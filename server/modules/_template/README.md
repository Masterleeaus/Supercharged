# Module template

A skeleton for a server module that follows the layout of `server/modules/widget/`:
an entry point, a router, a service, and a storage layer. Layers depend downward only:
routes call the service, the service calls storage, and storage talks to the database.

## Files

| File | Role |
| --- | --- |
| `index.ts` | Exports `register{{pascal}}Module(app, options)`. Builds the storage, service and router, then mounts them. |
| `template-routes.ts` | Express router. Each route chains `authenticateToken` and `requireRole(...)`. Holds the zod validation placeholder. |
| `template-service.ts` | Business rules and the `{{pascal}}Error` domain error. No Express or SQL. |
| `template-storage.ts` | `{{pascal}}Storage` interface, an in-memory implementation, and a Drizzle placeholder. |

The `template-` prefix on file names is replaced by the generator with `{{name}}-`. Name tokens inside the files are replaced too.

## Create a module

Option A, generator (recommended):

    node scripts/new-module.mjs my-thing

This copies this folder to `server/modules/my-thing/`, renames the files to `my-thing-*.ts`, and replaces the name tokens. It refuses to overwrite an existing folder and fails if any token is left behind.

Option B, by hand: copy this folder to `server/modules/<name>/`, rename `template-*` to `<name>-*`, and replace the tokens.

## Steps after generating

1. **Model the data.** Add a table to `@shared/schema`, then replace the body of `createDrizzle{{pascal}}Storage` using the query shape in the comment there.
2. **Define the contract.** Replace the fields of `create{{pascal}}Body` (zod) and the `{{pascal}}Record` fields in storage.
3. **Write the rules.** Add business logic to the service. Throw `{{pascal}}Error(message, status)` for expected failures.
4. **Set access.** Pick the roles in each `requireRole(...)` call. Admins always pass that check. Use `authenticateToken` only for routes that need no role.
5. **Mount it.** Import the register function where the app's routes are set up (`server/routes.ts` mounts other modules this way) and call it with the Express app:

       import { register{{pascal}}Module } from "./modules/{{name}}";
       register{{pascal}}Module(app);

   Pass `{ storage }` to inject a different implementation, and `{ basePath }` to change the mount path.
6. **Test the service.** Use `createMemory{{pascal}}Storage()` as the injected storage. No database is needed for service tests.

## Rules

- Routes never touch the database directly.
- Services never import Express types.
- Storage is always injected into the service. Nothing in the service constructs its own storage.
- Validate every request body with `safeParse` before it reaches the service.
