import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const publicRoutes = readFileSync(new URL("../../server/routes/public-routes.ts", import.meta.url), "utf8");
const brandingProvider = readFileSync(new URL("../../client/src/components/BrandingProvider.tsx", import.meta.url), "utf8");
const installer = readFileSync(new URL("../../client/src/pages/InstallWizard.tsx", import.meta.url), "utf8");

test("initial installer writes the company name into both company identity and app branding", () => {
  assert.match(publicRoutes, /const \{ adminEmail, adminPassword, companyName \} = req\.body;/);
  const installerRoute = publicRoutes.split('router.post("/api/installer/install"')[1]?.split('router.get(')[0];
  assert.ok(installerRoute, "installation endpoint exists");
  assert.match(installerRoute, /key: 'company_name', value: companyName/);
  assert.match(installerRoute, /key: 'app_name', value: companyName/);
  assert.match(installerRoute, /INSERT INTO global_settings/);
});

test("installer company name is required and submitted to the installation endpoint", () => {
  assert.match(installer, /companyName: ""/);
  assert.match(installer, /if \(!formData\.companyName\)/);
  assert.match(installer, /apiRequest\("POST", "\/api\/installer\/install", formData\)/);
});

test("saved app identity remains authoritative over the product fallback", () => {
  assert.match(publicRoutes, /branding\[key\] = setting\.value;/);
  assert.match(brandingProvider, /app_name: data\.app_name \|\| defaultBranding\.app_name,/);
});
