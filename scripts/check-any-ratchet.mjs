#!/usr/bin/env node
// Ratchet for explicit `any` (issue #15).
// Fails when lines ADDED in this change (vs a base ref) use `any` in server/, shared/ or client/src/.
// Existing `any` is not checked here: it is counted and reported only.
// Usage: node scripts/check-any-ratchet.mjs [baseRef=origin/main] [--count]
// Escape hatch for a justified line: add the comment `ratchet-allow-any` on the same line.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const countOnly = args.includes("--count");
const base = args.find((a) => !a.startsWith("--")) ?? "origin/main";
const SCOPE = ["server", "shared", "client/src"];
const EXT = /\.(ts|tsx|mts|cts)$/;
const ANY = /(:\s*any\b(?!\s*=>)|\bas\s+any\b|<any>|\bany\[\])/;

const git = (argv) => execFileSync("git", argv, { encoding: "utf8", maxBuffer: 1 << 26 });

if (countOnly) {
  const out = git(["grep", "-c", "-E", ":\\s*any\\b|\\bas\\s+any\\b", "--", ...SCOPE]);
  const total = out.split("\n").filter(Boolean).reduce((n, l) => n + Number(l.split(":").pop()), 0);
  console.log(`explicit any occurrences (baseline count, not a failure): ${total}`);
  process.exit(0);
}

const diff = git(["diff", "-U0", "--no-color", `${base}...HEAD`, "--", ...SCOPE]);
const failures = [];
let file = null;
let lineNo = 0;
for (const raw of diff.split("\n")) {
  if (raw.startsWith("+++ ")) {
    file = raw.slice(4).replace(/^b\//, "");
    continue;
  }
  const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
  if (hunk) {
    lineNo = Number(hunk[1]);
    continue;
  }
  if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
  const text = raw.slice(1);
  if (file && EXT.test(file) && ANY.test(text) && !text.includes("ratchet-allow-any")) {
    failures.push(`${file}:${lineNo}: ${text.trim()}`);
  }
  lineNo += 1;
}

if (failures.length) {
  console.error(`any-ratchet: ${failures.length} new explicit any in changed lines (base ${base}):`);
  for (const f of failures) console.error("  " + f);
  console.error("Use a precise type, unknown with narrowing, or add `ratchet-allow-any` with a reason.");
  process.exit(1);
}
console.log(`any-ratchet: no new explicit any in changed lines (base ${base}).`);
