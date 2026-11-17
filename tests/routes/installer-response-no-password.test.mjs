import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const routes = readFileSync(new URL("../../server/routes/public-routes.ts", import.meta.url), "utf8");
const wizard = readFileSync(new URL("../../client/src/pages/InstallWizard.tsx", import.meta.url), "utf8");

test("install success body returns admin email and id only", () => {
  assert.match(routes, /admin: \{\s*email: admin\.email,\s*id: admin\.id\s*\}/);
  assert.doesNotMatch(routes, /password:\s*adminPassword/);
});

test("install wizard takes the password from the form, not the response", () => {
  assert.doesNotMatch(wizard, /data\.admin\.password/);
  assert.match(wizard, /password: formData\.adminPassword/);
});
