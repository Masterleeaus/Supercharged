import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditSourceDuplicates, classifySourcePath } from "../../scripts/audit-source-duplicates.mjs";

async function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "supercharged-duplicate-audit-"));
  const make = (path, data) => {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, data);
    return absolute;
  };
  try {
    return await run({ root, make });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("source classification distinguishes donor, generated, and integration candidates", () => {
  assert.equal(classifySourcePath("_TITAN_HANDOFF/original.mjs"), "donor");
  assert.equal(classifySourcePath("dist/public/logo.svg"), "generated");
  assert.equal(classifySourcePath("server/integrations/example.mjs"), "active-tree");
  assert.equal(classifySourcePath("vendor/library.js"), "vendor");
  assert.equal(classifySourcePath("README.md"), "root");
});

test("audit groups byte-identical active/donor and active/generated files without edits", async () => {
  await withFixture(async ({ root, make }) => {
    const active = make("server/integrations/authority.mjs", "shared authority source");
    make("_TITAN_HANDOFF/packages/authority.mjs", "shared authority source");
    make("client/public/index.html", "static html");
    make("dist/public/index.html", "static html");
    make("server/unique.mjs", "distinct source");
    const old = readFileSync(active, "utf8");
    const report = await auditSourceDuplicates(root);
    assert.equal(report.fileCount, 5);
    assert.equal(report.uniqueHashes, 3);
    assert.equal(report.duplicateGroups, 2);
    assert.equal(report.duplicatedPaths, 4);
    assert.equal(report.activeDonorGroups, 1);
    assert.equal(report.activeGeneratedGroups, 1);
    assert.equal(report.destructiveChanges, 0);
    assert.equal(readFileSync(active, "utf8"), old);
    assert.equal(report.groups.every((g) => g.sha256.length === 64), true);
  });
});

test("different bytes at identical filenames are never presented as duplicates", async () => {
  await withFixture(async ({ root, make }) => {
    make("server/example.mjs", "version one");
    make("_TITAN_HANDOFF/example.mjs", "version two");
    const report = await auditSourceDuplicates(root);
    assert.equal(report.fileCount, 2);
    assert.equal(report.uniqueHashes, 2);
    assert.equal(report.duplicateGroups, 0);
  });
});

test("audit skips node_modules, .git, symlink sources and does not follow symlink directories", async () => {
  await withFixture(async ({ root, make }) => {
    make("server/actual.txt", "same");
    make("client/another.txt", "same");
    make("node_modules/copy.txt", "same");
    make(".git/copy.txt", "same");
    symlinkSync(join(root, "server/actual.txt"), join(root, "server/link.txt"));
    symlinkSync(join(root, "server"), join(root, "external"));
    const report = await auditSourceDuplicates(root);
    assert.equal(report.fileCount, 2);
    assert.equal(report.duplicateGroups, 1);
    assert.equal(report.groups[0].paths.length, 2);
  });
});
