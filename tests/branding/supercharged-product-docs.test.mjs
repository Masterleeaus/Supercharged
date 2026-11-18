import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const admin = read("../../client/src/components/admin/BrandingSettings.tsx");
const readme = read("../../README.md");
const installation = read("../../INSTALLATION.md");
const status = read("../../STATUS.md");

test("the admin branding form displays the active product identity", () => {
  assert.match(admin, /placeholder="Supercharged"/);
  assert.doesNotMatch(admin, /placeholder="AgentLabs"/);
  assert.match(admin, /apiRequest\("PATCH", "\/api\/admin\/branding", data\)/);
});

test("the root README identifies the product and distinguishes inherited capabilities", () => {
  assert.match(readme, /^# SuperchargedAt\.Work — communications, AI workforce and business connectors/m);
  assert.match(readme, /hosted communications\/agent capabilities only when the signed tenant-scoped contract/);
  assert.match(readme, /hosted service availability have not been certified by this README/);
  assert.ok(status.length > 0, "status document remains available");
});

test("installation guide uses the new product name without breaking historical deployment identifiers", () => {
  assert.match(installation, /^# Supercharged Installation Guide/m);
  assert.match(installation, /historical ZIP names, PM2 service identifiers, database names, and package paths/);
  assert.match(installation, /pm2 start npm --name "agentlabs"/);
  assert.match(installation, /issue #37/);
});
