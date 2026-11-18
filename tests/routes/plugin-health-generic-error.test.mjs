import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../server/routes/plugin-routes.ts", import.meta.url), "utf8");

test("plugin health returns a generic error string, not raw plugin errors", () => {
  assert.match(source, /const PLUGIN_HEALTH_GENERIC_ERROR = 'Plugin has a problem\. Check the server logs for details\.';/);
  assert.match(source, /error: \(plugin\.error \|\| missingTables\.length > 0\) \? PLUGIN_HEALTH_GENERIC_ERROR : undefined/);
  assert.doesNotMatch(source, /error: plugin\.error \|\|/);
  assert.doesNotMatch(source, /Missing database tables/);
});

test("raw plugin error is still logged server-side", () => {
  assert.match(source, /logger\.warn\(`\[Plugin Health\] \$\{plugin\.name\} reported an error: \$\{plugin\.error\}`\)/);
});
