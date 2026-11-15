/**
 * Central-governed feature flags for Supercharged (issue #196).
 *
 * - Every flag read has a local declared default. Central unreachable, a timeout,
 *   a non-200, a fallback answer, or a value of the wrong type all return the default.
 * - Reading an undeclared flag is a programming error and throws. It never defaults silently.
 * - A non-fallback 200 may be cached for at most 60 seconds. A fallback is never cached.
 * - The request carries no tenant, cohort or query data. Central takes the product from the token.
 * - Calls go through the service client from central-link (issue #214), which owns the
 *   client-credentials token, its cache and its refusal of tenant fields.
 *
 * DECLARED_FLAGS is empty because Central declares no flags for Supercharged yet (docs/CONFIG.md).
 */

export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_FLAG_CACHE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 1000;
const SOURCES = new Set(['override', 'cohort', 'rollout', 'global', 'default', 'fallback']);

export type FlagDeclaration =
  | { readonly type: 'boolean'; readonly default: boolean }
  | { readonly type: 'integer'; readonly default: number }
  | { readonly type: 'string'; readonly default: string; readonly allowed?: readonly string[] };

export type FlagValue = boolean | number | string;

/** Matches CentralServiceClient.request from central-link/service-client.ts. */
export type FlagRequest = (input: {
  method: 'GET';
  path: string;
}) => Promise<{ status: number; body: unknown }>;

export class UndeclaredFlagError extends Error {
  constructor(key: string) {
    super(`feature flag is not declared: ${FLAG_KEY_PATTERN.test(key) ? key : '(invalid key)'}`);
    this.name = 'UndeclaredFlagError';
  }
}

export const DECLARED_FLAGS: Readonly<Record<string, FlagDeclaration>> = Object.freeze({});

function validFor(declaration: FlagDeclaration, value: unknown): value is FlagValue {
  switch (declaration.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isSafeInteger(value);
    case 'string':
      return typeof value === 'string' &&
        (declaration.allowed === undefined || declaration.allowed.includes(value));
  }
}

export function createFlagReader(input: {
  declared: Readonly<Record<string, FlagDeclaration>>;
  environment: string;
  request: FlagRequest;
  clock?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
}): (key: string) => Promise<FlagValue> {
  const clock = input.clock ?? (() => Date.now());
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttl = Math.min(input.cacheTtlMs ?? MAX_FLAG_CACHE_MS, MAX_FLAG_CACHE_MS);
  const cache = new Map<string, { value: FlagValue; expiresAtMs: number }>();

  for (const [key, declaration] of Object.entries(input.declared)) {
    if (!FLAG_KEY_PATTERN.test(key) || !validFor(declaration, declaration.default)) {
      throw new TypeError('invalid flag declaration');
    }
  }

  return async function readFlag(key: string): Promise<FlagValue> {
    if (typeof key !== 'string' || !FLAG_KEY_PATTERN.test(key) || !Object.hasOwn(input.declared, key)) {
      throw new UndeclaredFlagError(key);
    }
    const declaration = input.declared[key] as FlagDeclaration;
    const fallback = declaration.default;

    const hit = cache.get(key);
    if (hit && clock() < hit.expiresAtMs) return hit.value;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        input.request({ method: 'GET', path: `/internal/v1/config/${input.environment}/${key}` }),
        deadline,
      ]);
      if (outcome === 'timeout') return fallback;
      if (outcome.status !== 200) return fallback;
      const body = outcome.body as { key?: unknown; value?: unknown; source?: unknown; revision?: unknown } | null;
      if (
        !body || typeof body !== 'object' ||
        body.key !== key || typeof body.source !== 'string' || !SOURCES.has(body.source) ||
        (body.revision !== null && !Number.isSafeInteger(body.revision)) ||
        !validFor(declaration, body.value)
      ) {
        return fallback;
      }
      if (body.source === 'fallback') return fallback;
      cache.set(key, { value: body.value, expiresAtMs: clock() + ttl });
      return body.value;
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  };
}
