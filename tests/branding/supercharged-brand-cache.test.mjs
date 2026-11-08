import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../../client/index.html", import.meta.url), "utf8");
const provider = readFileSync(new URL("../../client/src/components/BrandingProvider.tsx", import.meta.url), "utf8");
const server = readFileSync(new URL("../../server/routes/public-routes.ts", import.meta.url), "utf8");

// Execute the actual browser bootstrap script, not a test-only copy of its logic.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const bootstrap = scripts.map((match) => match[1]).find((source) => source.includes("agentlabs-branding:v3"));
assert.ok(bootstrap, "branding bootstrap script must exist");

function runBootstrap({ cached = null, now = 1_800_000_000_000 } = {}) {
  const links = [{ href: "/favicon.png" }];
  const document = {
    title: "Supercharged",
    getElementById(id) { return id === "dynamic-favicon" ? links[0] : null; },
  };
  const localStorage = {
    getItem(key) {
      assert.equal(key, "agentlabs-branding:v3");
      return cached;
    },
  };
  const FakeDate = class extends Date {
    static now() { return now; }
  };
  vm.runInNewContext(bootstrap, { document, localStorage, Date: FakeDate, Number, JSON });
  return { title: document.title, favicon: links[0].href };
}

test("unconfigured browser starts as Supercharged", () => {
  assert.deepEqual(runBootstrap(), { title: "Supercharged", favicon: "/favicon.png" });
});

test("fresh tenant branding is respected at first paint", () => {
  const cached = JSON.stringify({
    timestamp: 1_800_000_000_000 - 1000,
    data: { app_name: "Acme Cleaning", app_tagline: "Customer portal", favicon_url: "/acme.ico" },
  });
  assert.deepEqual(runBootstrap({ cached }), {
    title: "Acme Cleaning - Customer portal",
    favicon: "/acme.ico",
  });
});

test("expired or future-dated cache cannot restore outdated branding", () => {
  for (const timestamp of [1_800_000_000_000 - 86_400_001, 1_800_000_000_000 + 100]) {
    const cached = JSON.stringify({ timestamp, data: { app_name: "AgentLabs", favicon_url: "/old.ico" } });
    assert.deepEqual(runBootstrap({ cached }), { title: "Supercharged", favicon: "/favicon.png" });
  }
});

test("corrupt cache fails safely to product defaults", () => {
  assert.deepEqual(runBootstrap({ cached: "{broken" }), { title: "Supercharged", favicon: "/favicon.png" });
});

test("provider and bootstrap both validate cache age", () => {
  assert.match(provider, /const CACHE_KEY = "agentlabs-branding:v3"/);
  assert.match(provider, /age < 0 \|\| age > CACHE_TTL/);
});

test("public branding API has product fallback but preserves saved settings", () => {
  assert.match(server, /app_name: 'Supercharged'/);
  assert.match(server, /branding\[key\] = setting\.value/);
  assert.match(server, /brandingSettings\.app_name \|\| 'Supercharged'/);
});
