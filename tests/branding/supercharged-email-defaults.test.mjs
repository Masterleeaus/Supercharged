import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const emailService = readFileSync(new URL("../../server/services/email-service.ts", import.meta.url), "utf8");
const emailSeeds = readFileSync(new URL("../../server/seed-email-templates.ts", import.meta.url), "utf8");
const settingsSeeds = readFileSync(new URL("../../server/seed-global-settings.ts", import.meta.url), "utf8");

test("email service defaults to Supercharged without overriding configured sender identity", () => {
  assert.match(emailService, /const DEFAULT_COMPANY_NAME = 'Supercharged';/);
  assert.match(emailService, /const appName = \(appNameSetting\?\.value as string\) \|\| DEFAULT_COMPANY_NAME;/);
  assert.match(emailService, /fromName: \(fromNameSetting\?\.value as string\) \|\| appName,/);
  assert.match(emailService, /fromName: DEFAULT_COMPANY_NAME,/);
});

test("email service and new tenant global seeds use consistent, neutral descriptor", () => {
  assert.match(emailService, /const DEFAULT_TAGLINE = 'Business communications and operations';/);
  assert.match(settingsSeeds, /key: "company_tagline",\s*value: "Business communications and operations",/);
  assert.match(emailService, /tagline: \(taglineSetting\?\.value as string\) \|\| DEFAULT_TAGLINE,/);
});

test("email templates keep configurable business identity and avoid legacy platform promise", () => {
  assert.match(emailSeeds, /<title>{{companyName}}<\/title>/);
  assert.match(emailSeeds, /<h1 class="email-logo">{{companyName}}<\/h1>/);
  assert.match(emailSeeds, /Business communications and operations/);
  assert.doesNotMatch(emailSeeds, /AI-Powered Bulk Calling Platform/);
  assert.doesNotMatch(emailSeeds, /Our AI-powered bulk calling platform is designed to/);
});
