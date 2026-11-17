import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../server/routes/public-system-routes.ts", import.meta.url), "utf8");

function routeLine(path) {
  const line = source.split("\n").find((entry) => entry.includes(`router.get("${path}"`));
  assert.ok(line, `route ${path} is declared`);
  return line;
}

test("llm-margin settings route requires login", () => {
  assert.match(routeLine("/api/settings/llm-margin"), /router\.get\("\/api\/settings\/llm-margin", authenticateToken,/);
});

test("voice-engine settings route requires login", () => {
  assert.match(routeLine("/api/settings/voice-engine"), /router\.get\("\/api\/settings\/voice-engine", authenticateToken,/);
});
