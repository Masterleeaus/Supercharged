import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const provider = readFileSync(new URL("../../client/src/components/BrandingProvider.tsx", import.meta.url), "utf8");
const landing = readFileSync(new URL("../../client/src/pages/LandingPage.tsx", import.meta.url), "utf8");
const seoSeeds = readFileSync(new URL("../../server/seed-seo-settings.ts", import.meta.url), "utf8");

const signatureSource = provider.match(/function getBrandingSignature\(data: BrandingData\): string \{[\s\S]*?\r?\n\}/)?.[0];
assert.ok(signatureSource, "branding signature implementation must exist");
const getSignature = vm.runInNewContext(
  `(${signatureSource.replace("(data: BrandingData): string", "(data)")})`,
);

test("tagline and social URL edits invalidate provider branding state and cache", () => {
  const original = {
    app_name: "Example Business", app_tagline: "Old tagline",
    logo_url: null, logo_url_light: null, logo_url_dark: null, favicon_url: null,
    admin_email: null, app_location: null,
    social_twitter_url: null, social_linkedin_url: null, social_github_url: null,
    theme_primary: null, theme_primary_foreground: null, theme_accent: null,
    theme_background: null, theme_sidebar: null, theme_website_accent: null,
    theme_website_foreground: null,
  };
  for (const [key, value] of [
    ["app_tagline", "New tagline"],
    ["social_twitter_url", "https://example.com/twitter"],
    ["social_linkedin_url", "https://example.com/linkedin"],
    ["social_github_url", "https://example.com/github"],
  ]) {
    assert.notEqual(getSignature(original), getSignature({ ...original, [key]: value }), `${key} must invalidate cached branding`);
  }
});

test("removing custom favicon restores product favicon", () => {
  assert.match(provider, /const faviconUrl = branding\.favicon_url \|\| "\/favicon\.png";/);
  assert.match(provider, /existingFavicon\.setAttribute\("href", faviconUrl\)/);
});

test("invalid v3 cached branding payload is rejected", () => {
  assert.match(provider, /!parsed\.data \|\| typeof parsed\.data !== "object"/);
  assert.match(provider, /typeof parsed\.data\.app_name !== "string"/);
});

test("landing fallback uses tenant identity and does not claim unverified offers", () => {
  assert.match(landing, /\$\{branding\.app_name \|\| "Supercharged"\} \| AI Communications and Business Operations/);
  assert.doesNotMatch(seoSeeds, /Start free with 50 credits|Start your free trial today/);
  assert.match(seoSeeds, /Explore available plans and choose the capabilities/);
});
