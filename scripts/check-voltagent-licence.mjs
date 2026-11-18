#!/usr/bin/env node
/**
 * Licence gate for the VoltAgent integration (plan section 4, issue #388, gate G1).
 *
 * Runs on every PR (see .github/workflows/pr-checks.yml, job licence-gate).
 *
 * Fails (exit 1) if:
 *   (a) any tracked file, anywhere in the repo, has a path containing "/ee/" (enterprise code);
 *   (b) any tracked code file imports a package whose name starts with the Mastra scope (Mastra code must not be imported; copies
 *       must be original or Apache-2.0 files with attribution);
 *   (c) the Mastra reference snapshot is tracked (source/mastra-apache-only/README.md) but
 *       docs/mastra-attribution.md is missing or lacks the Apache-2.0 copyright notice.
 *
 * Otherwise exits 0 with a one-line summary.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MASTRA_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@mastra\//;
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const MASTRA_SNAPSHOT_README = 'source/mastra-apache-only/README.md';
const ATTRIBUTION_DOC = 'docs/mastra-attribution.md';
const REQUIRED_NOTICE = 'Copyright (c) 2025 Kepler Software, Inc.';
const REQUIRED_LICENCE = 'Apache-2.0';

/** Lists every tracked file in the repo, relative to the repo root. */
export function listTrackedFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/**
 * Pure audit. `files` is the tracked file list; `readFile(file)` returns the file text.
 * Returns { problems, checked, codeChecked }.
 */
export function auditLicence({ files, readFile }) {
  const problems = [];
  const tracked = new Set(files);

  for (const file of files) {
    if (`/${file}`.includes('/ee/')) {
      problems.push(`enterprise path: ${file}`);
    }
  }

  const codeFiles = files.filter((file) => CODE_FILE.test(file));
  for (const file of codeFiles) {
    if (MASTRA_IMPORT.test(readFile(file))) {
      problems.push(`@mastra import: ${file}`);
    }
  }

  if (tracked.has(MASTRA_SNAPSHOT_README)) {
    if (!tracked.has(ATTRIBUTION_DOC)) {
      problems.push(`missing attribution doc: ${ATTRIBUTION_DOC}`);
    } else {
      const doc = readFile(ATTRIBUTION_DOC);
      if (!doc.includes(REQUIRED_NOTICE)) {
        problems.push(`attribution doc lacks copyright notice: ${ATTRIBUTION_DOC}`);
      }
      if (!doc.includes(REQUIRED_LICENCE)) {
        problems.push(`attribution doc lacks ${REQUIRED_LICENCE} licence reference: ${ATTRIBUTION_DOC}`);
      }
    }
  }

  return { problems, checked: files.length, codeChecked: codeFiles.length };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = listTrackedFiles(repoRoot);
  const { problems, checked, codeChecked } = auditLicence({
    files,
    readFile: (file) => readFileSync(path.join(repoRoot, file), 'utf8'),
  });

  if (problems.length > 0) {
    for (const line of problems) console.error(`FAIL ${line}`);
    console.error(`check:licence failed with ${problems.length} problem(s).`);
    process.exit(1);
  }

  console.log(
    `check:licence ok: ${checked} tracked files, ${codeChecked} code files scanned, no /ee/ paths, no @mastra imports, attribution present.`,
  );
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
