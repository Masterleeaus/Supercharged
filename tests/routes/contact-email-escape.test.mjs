import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { escapeHtml } = await import("../../server/modules/marketing/page-render.ts");
const routes = readFileSync(new URL("../../server/routes/public-marketing-routes.ts", import.meta.url), "utf8");

test("escapeHtml neutralises markup in contact fields", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')">&`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;",
  );
});

test("contact email builds HTML only from escaped name, company, phone and message", () => {
  for (const field of ["name", "company", "phone", "message"]) {
    assert.match(routes, new RegExp(`escapeHtml\\(${field}\\)`), `${field} is escaped`);
  }
  assert.doesNotMatch(routes, /value">\$\{name\}/);
  assert.doesNotMatch(routes, /value">\$\{company\}/);
  assert.doesNotMatch(routes, /value">\$\{phone\}/);
  assert.doesNotMatch(routes, /message-box">\$\{message\}/);
});
