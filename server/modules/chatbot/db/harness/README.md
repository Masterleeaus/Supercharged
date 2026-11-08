# Chatbot draft-SQL harness

Applies the Desk base migrations, the chatbot parent tables and each chatbot draft to a fresh
Postgres 16 database, and reports every file that fails.

Files in this folder:

- `pg-local.sh`: starts, stops, resets and checks the local cluster.
- `apply-drafts.mjs`: creates the database and applies the files.
- `migration-order.json`: the order of the steps. Edit this file to change the order.

## 1. Start the cluster

    server/modules/chatbot/db/harness/pg-local.sh start

- Port 55432, data in `/tmp/chatbot-pg/data`, socket directory `/tmp/chatbot-pg-sock`, log in `/tmp/chatbot-pg/server.log`.
- Postgres refuses to run as root, so the script runs the cluster as the system user `pgtest`. It creates that user if it is missing.
- Auth is `trust`, and the server listens on 127.0.0.1 only. There is no password, and none is printed.

Other commands:

- `pg-local.sh status`: exit 0 when running.
- `pg-local.sh stop`: fast shutdown.
- `pg-local.sh reset`: stop, delete the data directory, and start a new empty cluster.

## 2. Apply the drafts

    cd <desk repo root>
    NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" \
      node server/modules/chatbot/db/harness/apply-drafts.mjs

- The script drops and recreates the database `chatbot_harness` each run. It leaves that database in place, so you can inspect it with `psql`.
- It needs the `pg` package. The repo has no `node_modules` here, so the hook above is used. It resolves `pg` from the scratch deps folder. With a normal `npm install` in the repo, the `NODE_OPTIONS` part is not needed.
- Set `CHATBOT_HARNESS_DATABASE_URL` to use another cluster. The default is `postgres://pgtest@127.0.0.1:55432/postgres`. Set `CHATBOT_HARNESS_DB` to change the database name.

Order of steps:

1. Base migrations from `migrations/`, numbered files only. The unnumbered `add_missing_columns.sql` and all `DRAFT_*` files are not base files.
2. Three promoted parent files: `migrations/0010a_inbox.sql` before `0011`, `migrations/0010b_approvals.sql` before `0013`, and `migrations/0010c_chatbot.sql` for the chatbot parent tables. They are copies of `DRAFT_inbox.sql`, `DRAFT_approvals.sql` and `DRAFT_chatbot.sql`. The originals are unchanged. The 0010a to 0010c names sort before 0011 and 0013, so a name-ordered runner applies them first.
3. The 16 chatbot drafts in `server/modules/chatbot/db/migrations-draft/`. `0000_bookings_tables.sql` creates the booking tables, and `0055_conversation_store_columns.sql` adds the conversation store columns. Both run before the other drafts. Two pairs of draft files share a number (`0002_*`, `0101_*`). The order file gives them unique positions, so no file was renamed.

Rules:

- Each file runs in its own transaction. `BEGIN` and `COMMIT` lines inside a file are skipped.
- A base or parent step that fails stops the run. A draft that fails does not stop the others.
- Each error prints the file, the line, the Postgres error code, the statement, and, for a missing table, where that table is defined in the repo.
- Exit code is 0 only when every step applies.

## 3. Run the test

    NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" \
      node --test --experimental-transform-types tests/modules/chatbot-db/harness.test.mjs

- When nothing listens on port 55432, the test is skipped with a message. The normal test run still passes.
- When the cluster is up, the test runs the harness and asserts that every draft applies.

## What passes and what does not

Current result on the local cluster (2026-11-09): all 16 drafts apply, and all 15 base and parent files apply. The test passes.

- `0000_bookings_tables.sql` is the SQL DDL for the booking tables from `db/bookings.ts`. It is what lets `0001_bookings_exclusion.sql` apply.
- `0055_conversation_store_columns.sql` adds `status`, `handler`, `merged_into_id`, `summary` and `summary_updated_at` to `chatbot_conversations`. The Drizzle definition in `shared/schema.ts` still needs the same columns.
- The harness test fails when any draft fails. It is skipped when no cluster is listening.

## Limits

- This checks that the SQL runs on Postgres 16 in an empty database. It does not check row-level security, data, or the application code.
- The harness does not rename or edit any draft. Fixes belong to the integration pass.
