import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditImportOwnership,
  extractLiteralImports,
  resolveRelativeImport,
  traceStaticEntrypoints,
} from "../../scripts/audit-import-ownership.mjs";

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "supercharged-import-audit-"));
  const make = (path, content) => {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  try { await run({ root, make }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("literal static, re-export, side-effect, require and dynamic imports are identified", () => {
  const source = [
    'import { x } from "./a.js";',
    'export * from "./b.mjs";',
    'import "./side.js";',
    'const value = require("./c.cjs");',
    'const module = import("./dynamic.js");',
    'const uncertain = import(path);',
    'const lazy = import.meta.glob("./pages/*.ts");',
  ].join("\n");
  const result = extractLiteralImports(source);
  assert.deepEqual(result.imports.map((x) => x.specifier).sort(), [
    "./a.js", "./b.mjs", "./c.cjs", "./dynamic.js", "./side.js",
  ]);
  assert.equal(result.dynamic, 1);
  assert.equal(result.glob, 1);
});

test("relative imports resolve explicit suffixes, extensionless imports, and index modules", () => {
  const paths = new Set(["server/a.ts", "server/helpers/index.mjs", "server/b.mjs"]);
  assert.equal(resolveRelativeImport("server/index.ts", "./a", paths), "server/a.ts");
  assert.equal(resolveRelativeImport("server/index.ts", "./helpers", paths), "server/helpers/index.mjs");
  assert.equal(resolveRelativeImport("server/index.ts", "./b.mjs", paths), "server/b.mjs");
  assert.equal(resolveRelativeImport("server/index.ts", "@shared/a", paths), null);
  assert.equal(resolveRelativeImport("server/index.ts", "./missing", paths), null);
});

test("audit identifies concrete integration imports but never claims them live", async () => {
  await fixture(async ({ root, make }) => {
    make("server/index.ts", 'import "./integrations/titan-revenue/route.mjs";');
    make("server/integrations/titan-revenue/route.mjs", 'import { go } from "./core.mjs";');
    make("server/integrations/titan-revenue/core.mjs", "export const go = true;");
    make("_TITAN_HANDOFF/snapshot.mjs", 'import "../server/integrations/titan-revenue/core.mjs";');
    make("server/missing.ts", 'import "./absent.js";');
    make("server/dynamic.ts", 'const x = import(getModuleName());');
    const report = auditImportOwnership(root);
    assert.equal(report.resolvedRelativeEdges, 2);
    assert.equal(report.unresolvedRelativeEdges, 1);
    assert.equal(report.dynamicSites.length, 1);
    const core = report.ownership.find((x) => x.path.endsWith("core.mjs"));
    assert.deepEqual(core.directImporters, ["server/integrations/titan-revenue/route.mjs"]);
    assert.equal(core.live, "unverified");
  });
});

test("audit skips generated files, dependencies and symlinked code", async () => {
  await fixture(async ({ root, make }) => {
    make("server/one.mjs", 'import "./two.mjs";');
    make("server/two.mjs", "export const ok = true;");
    make("dist/public/copy.mjs", "const x = 1;");
    make("node_modules/example/index.mjs", "const x = 1;");
    symlinkSync(join(root, "server/two.mjs"), join(root, "server/link.mjs"));
    const before = readFileSync(join(root, "server/two.mjs"), "utf8");
    const report = auditImportOwnership(root);
    assert.equal(report.sourceFiles, 2);
    assert.equal(report.resolvedRelativeEdges, 1);
    assert.equal(readFileSync(join(root, "server/two.mjs"), "utf8"), before);
  });
});

test("entrypoint trace handles cycles and transitive local imports without classifying unlinked modules live", () => {
  const edges = [
    { importer: "server/index.ts", target: "server/route.ts" },
    { importer: "server/route.ts", target: "server/shared.ts" },
    { importer: "server/shared.ts", target: "server/route.ts" },
    { importer: "server/unlinked.ts", target: "server/hidden.ts" },
  ];
  assert.deepEqual(traceStaticEntrypoints(edges, ["server/index.ts"]), [
    "server/index.ts", "server/route.ts", "server/shared.ts",
  ]);
  assert.deepEqual(traceStaticEntrypoints(edges, ["client/src/main.tsx"]), ["client/src/main.tsx"]);
});

test("audit reports direct static entrypoint chains and missing entrypoints separately", async () => {
  await fixture(async ({ root, make }) => {
    make("server/index.ts", 'import "./integrations/titan-revenue/route.mjs";');
    make("server/integrations/titan-revenue/route.mjs", 'import "./core.mjs";');
    make("server/integrations/titan-revenue/core.mjs", "export const value = 1;");
    make("server/integrations/titan-revenue/unreferenced.mjs", "export const value = 2;");
    const report = auditImportOwnership(root, {
      entrypoints: ["server/index.ts", "client/src/main.tsx"],
    });
    assert.deepEqual(report.entrypoints, ["server/index.ts"]);
    assert.deepEqual(report.missingEntrypoints, ["client/src/main.tsx"]);
    assert.equal(report.staticReachableFiles, 3);
    assert.equal(report.ownership.find((x) => x.path.endsWith("core.mjs")).staticEntrypointPathFound, true);
    assert.equal(report.ownership.find((x) => x.path.endsWith("unreferenced.mjs")).staticEntrypointPathFound, false);
    assert.equal(report.ownership.every((x) => x.live === "unverified"), true);
  });
});
