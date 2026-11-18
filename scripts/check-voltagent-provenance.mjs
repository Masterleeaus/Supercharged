#!/usr/bin/env node
/**
 * Provenance scan for the VoltAgent integration (issue #395).
 *
 * Usage: node scripts/check-voltagent-provenance.mjs <mastra-checkout> [target-dir]
 *
 * Reports every line of 50 or more characters (whitespace trimmed) in the target files that also appears
 * verbatim in a .ts, .tsx, .js, .mjs or .cjs file under packages/ or stores/ of the Mastra checkout.
 * Exits 0 when no line matches, 1 when any line matches, and 2 on bad arguments.
 *
 * The Mastra checkout is not part of this repository and CI does not run this script. It is a reproducible
 * check that an owner or reviewer runs against a fresh Mastra clone. See docs/mastra-attribution.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_LINE_CHARS = 50;
export const DEFAULT_TARGET = 'server/integrations/voltagent';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SOURCE_PATTERN = /\.(ts|tsx|js|mjs|cjs)$/;

/** Returns the trimmed lines of text that are long enough to count as evidence of copying. */
export function longLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_LINE_CHARS);
}

/** Returns the distinct target lines that also appear verbatim in any reference text. */
export function findVerbatimLines(referenceTexts, targetText) {
  const reference = new Set();
  for (const text of referenceTexts) {
    for (const line of longLines(text)) reference.add(line);
  }
  return [...new Set(longLines(targetText).filter((line) => reference.has(line)))];
}

/** Lists the implementation files under dir (.ts, .js and so on, excluding .d.ts), recursively. */
export function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (SOURCE_PATTERN.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main(argv) {
  const mastraRoot = argv[2];
  const targetDir = path.resolve(repoRoot, argv[3] ?? DEFAULT_TARGET);
  if (!mastraRoot || !existsSync(mastraRoot)) {
    console.error('usage: node scripts/check-voltagent-provenance.mjs <mastra-checkout> [target-dir]');
    return 2;
  }
  const referenceFiles = ['packages', 'stores']
    .map((sub) => path.join(mastraRoot, sub))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => listSourceFiles(dir));
  if (referenceFiles.length === 0) {
    console.error(`no packages/ or stores/ source files under ${mastraRoot}`);
    return 2;
  }
  const referenceTexts = referenceFiles.map((file) => readFileSync(file, 'utf8'));

  let total = 0;
  for (const file of listSourceFiles(targetDir)) {
    const matches = findVerbatimLines(referenceTexts, readFileSync(file, 'utf8'));
    total += matches.length;
    console.log(`${path.relative(repoRoot, file)}: ${matches.length} verbatim line(s)`);
  }
  console.log(`scanned ${referenceFiles.length} reference file(s); ${total} verbatim line(s) found.`);
  return total === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv);
}
