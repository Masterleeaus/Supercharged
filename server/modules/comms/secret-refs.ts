// Credential references for provider secrets. Application code asks for a credential by
// company, integration and name. Only the injected resolver ever sees a value.
// This module holds no values, never logs them, and its refs serialise without them.

export const INTEGRATIONS = [
  'telegram',
  'messenger',
  'instagram',
  'whatsapp',
  'sms_provider',
  'email_provider',
  'meta_app',
] as const;

export type Integration = (typeof INTEGRATIONS)[number];

export type SecretRefErrorCode = 'invalid_company' | 'invalid_integration' | 'invalid_name';

export class SecretRefError extends Error {
  readonly code: SecretRefErrorCode;

  constructor(code: SecretRefErrorCode) {
    super(code);
    this.name = 'SecretRefError';
    this.code = code;
  }
}

/** Opaque handle. It carries identity only, never a value. */
export interface SecretRef {
  readonly companyId: string;
  readonly integration: Integration;
  readonly name: string;
}

export type SecretResolver = (
  companyId: string,
  integration: Integration,
  name: string,
) => Promise<string | undefined>;

export type GetSecretResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'not_found' | 'foreign_ref' };

export interface SecretRefs {
  ref(companyId: string, integration: Integration, name: string): SecretRef;
  get(ref: SecretRef): Promise<GetSecretResult>;
  describe(ref: SecretRef): string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[a-z_]{1,40}$/;
const INTEGRATION_SET: ReadonlySet<string> = new Set(INTEGRATIONS);

export function createSecretRefs({ resolve }: { resolve: SecretResolver }): SecretRefs {
  if (typeof resolve !== 'function') {
    throw new TypeError('createSecretRefs requires a resolve function');
  }

  // Refs made by this module. A plain object literal with the same fields is not trusted.
  const issued = new WeakSet<object>();

  return {
    ref(companyId, integration, name) {
      if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) {
        throw new SecretRefError('invalid_company');
      }
      if (typeof integration !== 'string' || !INTEGRATION_SET.has(integration)) {
        throw new SecretRefError('invalid_integration');
      }
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw new SecretRefError('invalid_name');
      }
      const handle: SecretRef = Object.freeze({ companyId, integration, name });
      issued.add(handle);
      return handle;
    },

    async get(ref) {
      if (typeof ref !== 'object' || ref === null || !issued.has(ref)) {
        return { ok: false, reason: 'foreign_ref' };
      }
      const value = await resolve(ref.companyId, ref.integration, ref.name);
      if (value === undefined) {
        return { ok: false, reason: 'not_found' };
      }
      return { ok: true, value };
    },

    describe(ref) {
      if (typeof ref !== 'object' || ref === null || !issued.has(ref)) {
        return 'foreign_ref';
      }
      return `company:${ref.companyId} integration:${ref.integration}.${ref.name}`;
    },
  };
}
