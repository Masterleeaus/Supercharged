import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Source-level guard for Express registration order. Express answers in the order
// routes are registered, so a generic /api/plivo/voice/:callId route registered
// before a literal POST path would capture that path (issue #475 item 1, from #319).
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "plivo-webhooks.ts"), "utf8");

type Registration = { method: string; path: string; index: number };

function registrations(): Registration[] {
  const re = /app\.(get|post|put|delete|all)\(\s*'(\/api\/plivo[^']*)'/g;
  const out: Registration[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ method: m[1].toUpperCase(), path: m[2], index: m.index });
  }
  return out;
}

test("every literal Plivo POST route is registered before the generic :callId route", () => {
  const regs = registrations();
  const generic = regs.find((r) => r.method === "POST" && r.path === "/api/plivo/voice/:callId");
  assert.ok(generic, "generic /api/plivo/voice/:callId route must exist");

  const literalPosts = regs.filter((r) => r.method === "POST" && r.path.startsWith("/api/plivo/voice/") && !r.path.includes(":"));
  assert.ok(literalPosts.length >= 5, "expected literal voice POST routes to be found");
  for (const r of literalPosts) {
    assert.ok(r.index < generic.index, `${r.path} must be registered before /api/plivo/voice/:callId`);
  }
});

test("no Plivo method and path pair is registered twice", () => {
  const seen = new Set<string>();
  for (const r of registrations()) {
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate registration: ${key}`);
    seen.add(key);
  }
});

test("the generic :callId route is the last voice POST registration", () => {
  const voicePosts = registrations().filter((r) => r.method === "POST" && r.path.startsWith("/api/plivo/voice/"));
  const last = voicePosts[voicePosts.length - 1];
  assert.equal(last.path, "/api/plivo/voice/:callId");
});
