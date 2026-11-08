import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../server/utils/graceful-restart.ts", import.meta.url), "utf8");

function createHarness() {
  const timers = [];
  const shutdownSignals = [];
  const logs = [];
  const context = {
    logger: { info: (message) => logs.push(message) },
    gracefulShutdown: (signal) => { shutdownSignals.push(signal); return Promise.resolve(); },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
  };
  const executable = source
    .replace(/^import .*;\s*$/gm, "")
    .replace(/export function scheduleGracefulRestart\(reason: string\): void/, "function scheduleGracefulRestart(reason)")
    .replace(/export function isRestartScheduled\(\): boolean/, "function isRestartScheduled()");
  const exports = vm.runInNewContext(executable + "\n({ scheduleGracefulRestart, isRestartScheduled })", context);
  return { ...exports, timers, shutdownSignals, logs };
}

test("plugin restart uses registered graceful shutdown service", () => {
  const harness = createHarness();
  harness.scheduleGracefulRestart("Plugin enabled");
  assert.equal(harness.isRestartScheduled(), true);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 2000);
  assert.deepEqual(harness.shutdownSignals, []);
  harness.timers[0].callback();
  assert.deepEqual(harness.shutdownSignals, ["plugin-restart"]);
});

test("multiple plugin changes coalesce into one graceful shutdown", () => {
  const harness = createHarness();
  harness.scheduleGracefulRestart("First plugin");
  harness.scheduleGracefulRestart("Second plugin");
  harness.scheduleGracefulRestart("Third plugin");
  assert.equal(harness.timers.length, 1);
  harness.timers[0].callback();
  assert.deepEqual(harness.shutdownSignals, ["plugin-restart"]);
  assert.ok(harness.logs.some((entry) => entry.includes("coalescing")));
});

test("restart helper never directly exits the process or reads an unrelated global server", () => {
  assert.match(source, /import \{ gracefulShutdown \} from '\.\.\/services\/graceful-shutdown'/);
  assert.match(source, /void gracefulShutdown\('plugin-restart'\)/);
  assert.doesNotMatch(source, /process\.exit\(/);
  assert.doesNotMatch(source, /__httpServer/);
});

test("main application registers its server with the shutdown service", () => {
  const entry = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../../server/services/graceful-shutdown.ts", import.meta.url), "utf8");
  assert.match(entry, /registerServer\(server\)/);
  assert.match(service, /export function registerServer\(server: Server\)/);
  assert.match(service, /export async function gracefulShutdown\(/);
});

test("plugin admin and installer responses do not promise supervisor-independent restart", () => {
  const admin = readFileSync(new URL("../../server/routes/plugin-routes.ts", import.meta.url), "utf8");
  const installer = readFileSync(new URL("../../server/routes/plugin-installer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(admin, /Server will restart automatically/);
  assert.doesNotMatch(installer, /Server will restart automatically/);
  assert.match(admin, /configured process manager is required/);
  assert.match(installer, /configured process manager/);
});
