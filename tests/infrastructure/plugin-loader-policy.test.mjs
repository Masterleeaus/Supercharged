import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../server/plugins/loader.ts", import.meta.url), "utf8");

function fromSource(name, rewrites, sandbox) {
  const start = source.indexOf(name);
  const nextDoc = source.indexOf("\n/**", start);
  assert.ok(start >= 0 && nextDoc > start);
  let declaration = source.slice(start, nextDoc).trim();
  for (const [a, b] of rewrites) {
    assert.ok(declaration.includes(a), `missing source fragment: ${a}`);
    declaration = declaration.replace(a, b);
  }
  return vm.runInNewContext(`(${declaration.replace(/^export /, "")})`, sandbox);
}

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "supercharged-loader-policy-"));
  const create = (dir, manifest) => {
    const directory = path.join(root, dir);
    mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "plugin.json"), JSON.stringify(manifest));
    return directory;
  };
  try { return run({ root, create }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function diskLookup(root) {
  return fromSource("export function getPluginManifestFromDisk", [
    ["name: string): PluginManifest | undefined", "name)"],
    ["const parsed: unknown", "const parsed"],
    ["parsed as PluginManifest", "parsed"],
  ], { fs, path, pluginsDir: root });
}

function enablement(database) {
  const logger = { warn() {} };
  return fromSource("async function isPluginEnabled", [
    ["pluginName: string): Promise<boolean>", "pluginName)"],
    ["setting.value as any", "setting.value"],
  ], {
    db: database,
    globalSettings: { key: "key" },
    eq: (a, b) => [a, b],
    console: logger,
    logger,
  });
}

function dbWithSetting(value, fails = false) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  if (fails) throw new Error("database unavailable");
                  return value === undefined ? [] : [{ value }];
                },
              };
            },
          };
        },
      };
    },
  };
}

test("plugin enablement fails closed when database status cannot be verified", async () => {
  const read = enablement(dbWithSetting(undefined, true));
  assert.equal(await read("comms"), false);
});

test("existing absent-setting policy remains enabled for backwards compatibility", async () => {
  const read = enablement(dbWithSetting(undefined));
  assert.equal(await read("comms"), true);
});

test("explicit disabled settings remain disabled in object and string forms", async () => {
  for (const value of [{ enabled: false }, "false", false]) {
    assert.equal(await enablement(dbWithSetting(value))("comms"), false);
  }
  assert.equal(await enablement(dbWithSetting({ enabled: true }))("comms"), true);
});

test("on-disk plugin lookup rejects directory traversal and accepts valid manifest", () => fixture(({ root, create }) => {
  create("comms", { name: "comms", entryPoint: "index.mjs", registerFunction: "registerPlugin" });
  const read = diskLookup(root);
  assert.equal(read("comms").name, "comms");
  assert.equal(read("../comms"), undefined);
  assert.equal(read("Comms"), undefined);
  assert.equal(read("comms/../../elsewhere"), undefined);
}));

test("on-disk lookup rejects mismatched identity, path escape and invalid registration", () => fixture(({ root, create }) => {
  create("badname", { name: "another", entryPoint: "index.mjs", registerFunction: "registerPlugin" });
  create("escape", { name: "escape", entryPoint: "../outside.mjs", registerFunction: "registerPlugin" });
  create("invalid", { name: "invalid", entryPoint: "index.mjs", registerFunction: "register()" });
  const read = diskLookup(root);
  for (const name of ["badname", "escape", "invalid"]) assert.equal(read(name), undefined);
}));

test("on-disk lookup rejects symlinked manifest and symlinked plugin directory", () => fixture(({ root, create }) => {
  const valid = { name: "normal", entryPoint: "index.mjs", registerFunction: "registerPlugin" };
  create("normal", valid);
  const linked = path.join(root, "linked");
  symlinkSync(path.join(root, "normal"), linked, "dir");
  const symlinkManifestDir = path.join(root, "symlink-manifest");
  mkdirSync(symlinkManifestDir);
  symlinkSync(path.join(root, "normal", "plugin.json"), path.join(symlinkManifestDir, "plugin.json"));
  const read = diskLookup(root);
  assert.equal(read("linked"), undefined);
  assert.equal(read("symlink-manifest"), undefined);
  assert.equal(read("normal").name, "normal");
}));
