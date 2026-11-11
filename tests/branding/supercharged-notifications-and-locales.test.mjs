import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const notification = readFileSync(new URL("../../server/services/notification-service.ts", import.meta.url), "utf8");
const localesFolder = new URL("../../client/src/i18n/locales/", import.meta.url);
const localeFiles = readdirSync(localesFolder).filter((name) => name.endsWith(".json"));

test("notification app name defaults to Supercharged and keeps configured nonblank names", () => {
  assert.match(notification, /const DEFAULT_APP_NAME = 'Supercharged';/);
  assert.match(notification, /storage\.getGlobalSetting\('app_name'\)/);
  assert.match(notification, /typeof setting\?\.value === 'string' && setting\.value\.trim\(\) \? setting\.value : DEFAULT_APP_NAME/);
  assert.match(notification, /return DEFAULT_APP_NAME;/);
});

test("the translated UI files are valid JSON with no obsolete product-name literals", () => {
  assert.equal(localeFiles.length, 12, "review the locale inventory when languages are added or removed");
  for (const filename of localeFiles) {
    const source = readFileSync(new URL(filename, localesFolder), "utf8");
    assert.doesNotThrow(() => JSON.parse(source), `${filename} must be valid JSON`);
    assert.doesNotMatch(source, /agentlabs|agent labs|diploy/gi, `${filename} must not contain former product labels`);
  }
});
