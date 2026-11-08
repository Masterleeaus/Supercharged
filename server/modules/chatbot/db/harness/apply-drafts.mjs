#!/usr/bin/env node
// Chatbot draft-SQL harness. Creates a fresh database on a local Postgres,
// applies the Desk base migrations, the chatbot parent tables, then each
// chatbot draft in the order in migration-order.json. See README.md here.
//
// Connection: CHATBOT_HARNESS_DATABASE_URL (an admin URL on the cluster,
// any database). Default: postgres://pgtest@127.0.0.1:55432/postgres (no
// password; the cluster uses trust auth on 127.0.0.1 only).
// Database name: CHATBOT_HARNESS_DB (default chatbot_harness).
//
// Exit code: 0 when every base, parent and draft file applies; 1 otherwise.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// harness -> db -> chatbot -> modules -> server -> repo root
const REPO = resolve(HERE, "../../../../..");
const ORDER_FILE = join(HERE, "migration-order.json");

const ADMIN_URL =
  process.env.CHATBOT_HARNESS_DATABASE_URL || "postgres://pgtest@127.0.0.1:55432/postgres";
const DB_NAME = process.env.CHATBOT_HARNESS_DB || "chatbot_harness";

const CONTROL_STATEMENT = /^(BEGIN|START\s+TRANSACTION|COMMIT|END)$/i;

/**
 * Split SQL text into top-level statements. Skips line and block comments,
 * and respects single quotes, double quotes and dollar-quoted bodies, so a
 * semicolon inside a function body does not end a statement.
 * Returns [{ text, line }] where line is the 1-based line of the first code character.
 */
export function splitStatements(sql) {
  const out = [];
  const n = sql.length;
  let i = 0;
  let line = 1;
  let start = -1;
  let startLine = 0;

  const flush = (endIdx) => {
    const text = sql.slice(start, endIdx).trim();
    if (text) out.push({ text, line: startLine });
    start = -1;
  };

  while (i < n) {
    const c = sql[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (sql[k] === "\n") line++;
      i = stop;
      continue;
    }
    if (start === -1) {
      start = i;
      startLine = line;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === "\n") line++;
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 128));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        for (let k = i; k < stop; k++) if (sql[k] === "\n") line++;
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      i++;
      flush(i);
      continue;
    }
    i++;
  }
  if (start !== -1) flush(n);
  return out;
}

function listFiles(dir, ext) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...listFiles(full, ext));
    else if (name.endsWith(ext)) found.push(full);
  }
  return found;
}

const rel = (p) => relative(REPO, p);

/** Where a missing table is defined in the repo (SQL DDL and Drizzle schema). */
function findDefinitions(table) {
  const esc = table.replace(/[^a-z0-9_]/gi, "");
  const createRe = new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${esc}"?\\s*\\(`, "i");
  const drizzleRe = new RegExp(`pgTable\\(\\s*["']${esc}["']`);
  const sqlHits = [];
  const drizzleHits = [];
  for (const dir of [join(REPO, "migrations"), join(REPO, "server/modules/chatbot/db/migrations-draft")]) {
    for (const f of listFiles(dir, ".sql")) {
      if (createRe.test(readFileSync(f, "utf8"))) sqlHits.push(rel(f));
    }
  }
  const tsFiles = [...listFiles(join(REPO, "server/modules/chatbot"), ".ts"), join(REPO, "shared/schema.ts")];
  for (const f of tsFiles) {
    if (existsSync(f) && drizzleRe.test(readFileSync(f, "utf8"))) drizzleHits.push(rel(f));
  }
  return { sqlHits, drizzleHits };
}

function hintForMissingTable(table) {
  const { sqlHits, drizzleHits } = findDefinitions(table);
  if (sqlHits.length) return `table "${table}" has SQL DDL in: ${sqlHits.join(", ")} (not applied before this file)`;
  if (drizzleHits.length)
    return `table "${table}" is only defined in Drizzle (${drizzleHits.join(", ")}); no SQL DDL exists in the repo`;
  return `table "${table}" is not defined anywhere in the repo`;
}

function describeError(err, stmt) {
  const preview = stmt.text.replace(/\s+/g, " ").slice(0, 160);
  let line = stmt.line;
  if (err.position) {
    const within = stmt.text.slice(0, Number(err.position) - 1);
    line = stmt.line + (within.match(/\n/g) || []).length;
  }
  const out = {
    code: err.code,
    message: err.message,
    line,
    preview,
    detail: err.detail || null,
    hint: null,
  };
  if (err.code === "42P01") {
    const m = /relation "([^"]+)" does not exist/.exec(err.message);
    if (m) out.hint = hintForMissingTable(m[1]);
  }
  return out;
}

async function applyFile(pgMod, dbUrl, file, absPath) {
  const sql = readFileSync(absPath, "utf8");
  const statements = splitStatements(sql).filter((s) => !CONTROL_STATEMENT.test(s.text.replace(/;\s*$/, "").trim()));
  const client = new pgMod.Client({ connectionString: dbUrl });
  await client.connect();
  let executed = 0;
  try {
    await client.query("BEGIN");
    for (const stmt of statements) {
      try {
        await client.query(stmt.text);
        executed++;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        return { file, ok: false, executed, total: statements.length, failure: describeError(err, stmt) };
      }
    }
    await client.query("COMMIT");
    return { file, ok: true, executed, total: statements.length };
  } finally {
    await client.end().catch(() => {});
  }
}

async function loadPg() {
  try {
    const mod = await import("pg");
    return mod.default ?? mod;
  } catch {
    console.error(
      "Cannot load the 'pg' package. Install it in the repo, or run with\n" +
        '  NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs"\n' +
        "as described in README.md.",
    );
    return null;
  }
}

function report(stage, result) {
  const tag = `[${stage}]`;
  if (result.ok) {
    console.log(`${tag} OK    ${result.file}  (${result.executed}/${result.total} statements)`);
    return;
  }
  const f = result.failure;
  console.log(`${tag} FAIL  ${result.file}`);
  console.log(`        line ${f.line}: ${f.code} ${f.message}`);
  console.log(`        statement: ${f.preview}`);
  if (f.detail) console.log(`        detail: ${f.detail}`);
  if (f.hint) console.log(`        dependency: ${f.hint}`);
}

async function main() {
  if (!/^[a-z_][a-z0-9_]*$/.test(DB_NAME)) {
    console.error("CHATBOT_HARNESS_DB must be a plain lowercase identifier.");
    return 1;
  }
  const pgMod = await loadPg();
  if (!pgMod) return 1;

  const order = JSON.parse(readFileSync(ORDER_FILE, "utf8"));
  const steps = order.steps;
  const missing = steps.filter((s) => !existsSync(join(REPO, s.file)));
  if (missing.length) {
    for (const s of missing) console.error(`missing file listed in migration-order.json: ${s.file}`);
    return 1;
  }
  const draftCount = steps.filter((s) => s.stage === "draft").length;

  const admin = new URL(ADMIN_URL);
  const target = new URL(ADMIN_URL);
  target.pathname = `/${DB_NAME}`;
  console.log(`cluster ${admin.hostname}:${admin.port || 5432}, fresh database "${DB_NAME}"`);

  const adminClient = new pgMod.Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  try {
    await adminClient.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await adminClient.query(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await adminClient.end().catch(() => {});
  }

  const failures = [];
  const draftResults = [];
  let halted = false;
  for (const { stage, file } of steps) {
    const result = await applyFile(pgMod, target.toString(), file, join(REPO, file));
    report(stage, result);
    if (stage === "draft") draftResults.push(result);
    if (!result.ok) {
      failures.push({ stage, file, failure: result.failure });
      if (stage !== "draft") {
        halted = true;
        break;
      }
    }
  }

  if (halted) {
    console.log("Stopped: a base or parent file failed, so the later steps were not run.");
  }
  const applied = draftResults.filter((r) => r.ok).length;
  console.log(`drafts applied: ${applied} of ${draftCount}`);
  if (failures.length) {
    console.log(`failures: ${failures.length}`);
    for (const f of failures) console.log(`  - [${f.stage}] ${f.file}: ${f.failure.code} ${f.failure.message}`);
    return 1;
  }
  console.log("all files applied");
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("harness error:", err.message);
      process.exitCode = 1;
    });
}
