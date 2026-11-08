// Runs the chatbot draft-SQL harness against the local Postgres 16 cluster and
// asserts that every draft applies. Skipped when no cluster is listening.
// Start the cluster with: server/modules/chatbot/db/harness/pg-local.sh start
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const harness = join(repoRoot, "server/modules/chatbot/db/harness/apply-drafts.mjs");

const PORT = Number(process.env.CHATBOT_PG_PORT || 55432);

function clusterListening(port) {
  return new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 1000 });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => done(false));
  });
}

const up = await clusterListening(PORT);
const skipReason = up
  ? false
  : `no Postgres cluster on 127.0.0.1:${PORT}; start it with server/modules/chatbot/db/harness/pg-local.sh start`;

test("every chatbot draft applies to a fresh database", { skip: skipReason, timeout: 300000 }, () => {
  const run = spawnSync(process.execPath, [harness], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 280000,
    env: { ...process.env, CHATBOT_HARNESS_DATABASE_URL: process.env.CHATBOT_HARNESS_DATABASE_URL || `postgres://pgtest@127.0.0.1:${PORT}/postgres` },
  });
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  assert.equal(run.status, 0, `harness exited ${run.status}\n${output}`);
  assert.match(output, /all files applied/, output);
});
