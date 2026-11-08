import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import test from "node:test";

import { createSqliteStorage, type StorageClient } from "../../../packages/storage/src/index.js";
import { createReadinessStorageProbe, createWorkforceServer } from "./server.js";

test("timed-out readiness storage probes share one queued SQLite read until it settles", async () => {
  const storage = createSqliteStorage(":memory:");
  await storage.query("CREATE TABLE workforce_work_items (id INTEGER PRIMARY KEY)");
  let probeQueries = 0;
  const query = storage.query.bind(storage);
  storage.query = ((sql: string, params?: readonly unknown[]) => {
    if (sql === "SELECT 1 FROM workforce_work_items LIMIT 1") probeQueries += 1;
    return query(sql, params);
  }) as StorageClient["query"];
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    const transaction = storage.transaction(async tx => {
      enter();
      await blocked;
      await tx.query("SELECT 1");
    });
    await entered;
    const probeStorage = createReadinessStorageProbe(storage);
    const first = probeStorage();
    const second = probeStorage();
    const third = probeStorage();
    assert.strictEqual(first, second);
    assert.strictEqual(second, third);
    assert.equal(probeQueries, 1);

    release();
    await transaction;
    await first;
    const next = probeStorage();
    assert.notStrictEqual(next, first);
    await next;
    assert.equal(probeQueries, 2, "a fresh probe starts after the shared read settles");
  } finally {
    release();
    await storage.close();
  }
});

async function listen(host: Awaited<ReturnType<typeof createWorkforceServer>>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    host.server.once("error", reject);
    host.server.listen(0, "127.0.0.1", resolve);
  });
  const address = host.server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("malformed request targets return 400 without terminating the workforce host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "titan-workforce-malformed-"));
  const host = await createWorkforceServer({ storagePath: join(directory, "workforce.db") });
  const baseUrl = await listen(host);
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(baseUrl).port), "127.0.0.1");
      let received = "";
      socket.setEncoding("utf8");
      socket.setTimeout(5000, () => socket.destroy(new Error("request timed out")));
      socket.on("error", reject);
      socket.on("data", chunk => { received += chunk; });
      socket.on("end", () => resolve(received));
      socket.on("connect", () => {
        socket.write("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      });
    });
    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /invalid_request_target/);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
  } finally {
    await host.close();
  }
});

test("unconfigured runtime stays unready despite durable storage across host restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "titan-workforce-"));
  const databasePath = join(directory, "workforce.db");

  const firstHost = await createWorkforceServer({ storagePath: databasePath });
  const firstUrl = await listen(firstHost);
  try {
    const health = await fetch(`${firstUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      service: "workforce",
      checks: { process: "ok" },
    });

    const ready = await fetch(`${firstUrl}/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), {
      status: "degraded",
      service: "workforce",
      checks: { storage: "ok", runtime: "unconfigured", authentication: "fail", authority: "fail", provider: "fail", evidence: "fail" },
    });

    const method = await fetch(`${firstUrl}/ready`, { method: "POST" });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET");

    const missing = await fetch(`${firstUrl}/unknown`);
    assert.equal(missing.status, 404);
  } finally {
    await firstHost.close();
  }

  const database = await readFile(databasePath);
  assert.ok(database.byteLength > 0);

  const restartedHost = await createWorkforceServer({ storagePath: databasePath });
  const restartedUrl = await listen(restartedHost);
  try {
    const readyAfterRestart = await fetch(`${restartedUrl}/ready`);
    assert.equal(readyAfterRestart.status, 503);
    assert.deepEqual(await readyAfterRestart.json(), {
      status: "degraded",
      service: "workforce",
      checks: { storage: "ok", runtime: "unconfigured", authentication: "fail", authority: "fail", provider: "fail", evidence: "fail" },
    });
  } finally {
    await restartedHost.close();
  }
});
