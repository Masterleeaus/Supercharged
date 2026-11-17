#!/usr/bin/env node
/**
 * Licence gate for the VoltAgent integration (plan section 3, gate G1).
 *
 * Fails (exit 1) if:
 *   (a) any tracked file under server/integrations/ or tests/integrations/
 *       has a path containing "/ee/" (enterprise code), or
 *   (b) any tracked file under server/integrations/ imports from "@mastra/".
 *
 * Otherwise exits 0 with a one-line summary.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPES = ['server/integrations/', 'tests/integrations/'];
const MASTRA_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@mastra\//;

function trackedFiles(prefixes) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...prefixes], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

const problems = [];
const scoped = trackedFiles(SCOPES);

for (const file of scoped) {
  if (`/${file}`.includes('/ee/')) {
    problems.push(`enterprise path: ${file}`);
  }
}

const integrationFiles = scoped.filter((file) => file.startsWith('server/integrations/'));
for (const file of integrationFiles) {
  const source = readFileSync(path.join(repoRoot, file), 'utf8');
  if (MASTRA_IMPORT.test(source)) {
    problems.push(`@mastra import: ${file}`);
  }
}

if (problems.length > 0) {
  for (const line of problems) console.error(`FAIL ${line}`);
  console.error(`check:licence failed with ${problems.length} problem(s).`);
  process.exit(1);
}

console.log(
  `check:licence ok: ${scoped.length} tracked files checked, ${integrationFiles.length} under server/integrations, no /ee/ paths, no @mastra imports.`,
);
process.exit(0);
