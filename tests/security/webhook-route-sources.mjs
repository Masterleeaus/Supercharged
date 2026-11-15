// Source-text helper for the security tests that inspect the webhook handlers.
// server/routes/webhook-routes.ts is now a re-export barrel; the handlers live in server/routes/webhook-modules/.
// Reading the barrel plus every module as one string keeps the assertions about the same code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WEBHOOK_BARREL = 'server/routes/webhook-routes.ts';

export function readWebhookRouteSources() {
  const dir = path.join(ROOT, 'server/routes/webhook-modules');
  const modules = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort().map((f) => path.join(dir, f));
  return [path.join(ROOT, WEBHOOK_BARREL), ...modules].map((p) => fs.readFileSync(p, 'utf8')).join('\n');
}
