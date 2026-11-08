import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const publicRoutes = readFileSync(new URL("../../server/routes/public-routes.ts", import.meta.url), "utf8");
const adminRoutes = readFileSync(new URL("../../server/routes/admin/branding-routes.ts", import.meta.url), "utf8");
const adminSettings = readFileSync(new URL("../../client/src/components/admin/BrandingSettings.tsx", import.meta.url), "utf8");

test("public API supplies Supercharged when app_name has never been stored", () => {
  const route = publicRoutes.split('router.get("/api/branding"')[1]?.split("// SEO ROUTES")[0];
  assert.ok(route, "public branding route exists");
  assert.match(route, /app_name: 'Supercharged'/);
  assert.match(route, /branding\[key\] = setting\.value/);
});

test("public API ignores blank app_name but retains configured names", () => {
  const route = publicRoutes.split('router.get("/api/branding"')[1]?.split("// SEO ROUTES")[0];
  assert.match(route, /key === 'app_name' && \(typeof setting\.value !== 'string' \|\| !setting\.value\.trim\(\)\)/);
  assert.match(route, /branding\[key\] = setting\.value;/);
});

test("admin branding settings render a product fallback without replacing customer values", () => {
  const route = adminRoutes.split("router.get('/branding'")[1]?.split("router.patch('/branding'")[0];
  assert.ok(route, "admin branding GET exists");
  assert.match(route, /app_name: 'Supercharged'/);
  assert.match(route, /key === 'app_name' && \(typeof setting\.value !== 'string' \|\| !setting\.value\.trim\(\)\)/);
  assert.match(route, /branding\[key\] = setting\.value;/);
  assert.match(adminSettings, /queryKey: \["\/api\/admin\/branding"\]/);
});

test("admin branding edits still save explicitly configured product identity", () => {
  assert.match(adminRoutes, /if \(app_name !== undefined\) await storage\.updateGlobalSetting\('app_name', app_name\)/);
});
