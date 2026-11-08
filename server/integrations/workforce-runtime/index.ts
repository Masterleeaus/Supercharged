/**
 * Selects the workforce runtime for the app. Returns the fail-closed disabled runtime unless
 * TITAN_WORKFORCE_URL and TITAN_WORKFORCE_SECRET are both present and valid. Never throws, so
 * the app starts in every configuration.
 */
import type { WorkforceRuntimePort } from './port.ts';
import { DisabledWorkforceRuntime } from './disabled-runtime.ts';
import { HttpWorkforceRuntime } from './http-runtime.ts';
// @ts-ignore pure ESM config resolver shared with tests
import { resolveRuntimeConfig } from './wire.mjs';

export type WorkforceRuntimeEnv = Record<string, string | undefined>;

export function createWorkforceRuntime(env: WorkforceRuntimeEnv = process.env): WorkforceRuntimePort {
  const config = resolveRuntimeConfig(env) as
    | { ok: true; baseUrl: string; secret: string }
    | { ok: false; reason: string };
  if (!config.ok) return new DisabledWorkforceRuntime(config.reason);
  try {
    return new HttpWorkforceRuntime({ baseUrl: config.baseUrl, secret: config.secret });
  } catch {
    // Defence in depth: resolveRuntimeConfig already checked these, so this only protects
    // against a future change to the client. The error message is intentionally not read.
    return new DisabledWorkforceRuntime('runtime_client_rejected_config');
  }
}

export { DisabledWorkforceRuntime } from './disabled-runtime.ts';
export { HttpWorkforceRuntime } from './http-runtime.ts';
export * from './port.ts';
