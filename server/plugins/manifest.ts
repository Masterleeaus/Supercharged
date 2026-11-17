/**
 * Plugin manifest validator.
 *
 * Pure: no filesystem, network, database or environment access. The caller reads
 * plugin.json and passes the parsed value in. Checks the loader's required keys and
 * the mode rule: a plugin names one Desk mode, and every module it lists must be
 * mounted by that mode in server/modules/desk-modes/mode-modules.ts.
 *
 * Shared modules (auth, audit, tenancy, approvals) are in both modes, so a plugin
 * may list them in either. A workforce-only module listed by a comms plugin, or the
 * reverse, is rejected.
 */
import { MODE_MODULES, exclusiveModules } from '../modules/desk-modes/mode-modules.ts';
import type { DeskMode } from '../modules/desk-modes/mode-resolver.ts';

export type ManifestIssue = { path: string; message: string };

export interface PluginManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  entryPoint: string;
  registerFunction: string;
  mode: DeskMode;
  modules: string[];
  features?: string[];
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: ManifestIssue[] };

/** Top-level keys the loader (server/plugins/loader.ts) understands, plus the mode and modules keys. */
const KNOWN_KEYS = new Set([
  'name',
  'displayName',
  'version',
  'description',
  'author',
  'license',
  'homepage',
  'compatibility',
  'entryPoint',
  'registerFunction',
  'database',
  'routes',
  'ui',
  'permissions',
  'features',
  'scopes',
  'settings',
  'mode',
  'modules',
]);

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ENTRY_PATTERN = /\.(?:mjs|js|ts)$/;
const MODES = Object.keys(MODE_MODULES) as DeskMode[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: ManifestIssue[],
): value is string {
  if (typeof value !== 'string') {
    errors.push({ path, message: 'must be a string' });
    return false;
  }
  const length = value.trim().length;
  if (length < min || length > max) {
    errors.push({ path, message: `must be ${min} to ${max} characters` });
    return false;
  }
  return true;
}

/** Validates a parsed plugin.json. Returns every issue found, not just the first. */
export function validatePluginManifest(raw: unknown): ManifestResult {
  const errors: ManifestIssue[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ path: '(root)', message: 'manifest must be a JSON object' }] };
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) errors.push({ path: key, message: 'unknown manifest key' });
  }

  if (typeof raw.name !== 'string' || !NAME_PATTERN.test(raw.name)) {
    errors.push({
      path: 'name',
      message: 'must be kebab-case, 2 to 64 characters, starting with a letter (it is also the folder name)',
    });
  }
  boundedString(raw.displayName, 'displayName', 3, 80, errors);
  if (typeof raw.version !== 'string' || !SEMVER_PATTERN.test(raw.version)) {
    errors.push({ path: 'version', message: 'must be a semantic version, e.g. 0.1.0' });
  }
  boundedString(raw.description, 'description', 10, 400, errors);
  boundedString(raw.author, 'author', 1, 120, errors);

  if (
    typeof raw.entryPoint !== 'string' ||
    !ENTRY_PATTERN.test(raw.entryPoint) ||
    raw.entryPoint.startsWith('/') ||
    raw.entryPoint.includes('\\') ||
    raw.entryPoint.split('/').includes('..')
  ) {
    errors.push({ path: 'entryPoint', message: 'must be a relative .mjs, .js or .ts path inside the plugin folder' });
  }
  if (typeof raw.registerFunction !== 'string' || !IDENTIFIER_PATTERN.test(raw.registerFunction)) {
    errors.push({ path: 'registerFunction', message: 'must be the name of an exported function' });
  }

  const mode = raw.mode;
  let validMode: DeskMode | null = null;
  if (typeof mode === 'string' && (MODES as string[]).includes(mode)) {
    validMode = mode as DeskMode;
  } else {
    errors.push({ path: 'mode', message: `must be one of ${MODES.join(', ')}` });
  }

  if (raw.features !== undefined) {
    if (!Array.isArray(raw.features) || raw.features.some((f) => typeof f !== 'string')) {
      errors.push({ path: 'features', message: 'must be an array of strings' });
    }
  }

  if (!Array.isArray(raw.modules) || raw.modules.length === 0) {
    errors.push({ path: 'modules', message: 'must be a non-empty array of module names' });
  } else {
    const seen = new Set<string>();
    raw.modules.forEach((mod, index) => {
      const path = `modules.${index}`;
      if (typeof mod !== 'string' || mod.length === 0) {
        errors.push({ path, message: 'must be a module name' });
        return;
      }
      if (seen.has(mod)) {
        errors.push({ path, message: `duplicate module "${mod}"` });
        return;
      }
      seen.add(mod);
      if (validMode === null) return;
      if (MODE_MODULES[validMode].includes(mod)) return;

      // Not in this mode. Shared modules are in both modes, so anything reaching here
      // that another mode mounts is exclusive to that mode.
      const other = MODES.find((m) => m !== validMode && exclusiveModules(m).includes(mod));
      if (other) {
        errors.push({
          path,
          message: `module "${mod}" belongs only to the ${other} mode and cannot be used by a ${validMode} plugin`,
        });
      } else {
        errors.push({ path, message: `module "${mod}" is not mounted by any Desk mode` });
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      name: raw.name as string,
      displayName: (raw.displayName as string).trim(),
      version: raw.version as string,
      description: (raw.description as string).trim(),
      author: (raw.author as string).trim(),
      entryPoint: raw.entryPoint as string,
      registerFunction: raw.registerFunction as string,
      mode: validMode as DeskMode,
      modules: [...(raw.modules as string[])],
      ...(raw.features !== undefined ? { features: [...(raw.features as string[])] } : {}),
    },
  };
}

/*
 * Connector manifests (#350). A connector lives in plugins/<name>/connector.json and is validated
 * on its own: an invalid connector manifest blocks only that connector, never the plugins around it.
 * Pure, like validatePluginManifest. Unknown keys are rejected so a typo cannot silently drop a rule.
 */

/*
 * The lists below copy server/connectors/sdk/contract.ts. This file imports no other connector code
 * (the plugin validator test pins its imports). tests/connectors/registry.test.mjs checks they match.
 */
const AUTH_TYPES = ['oauth2', 'api_key', 'none'] as const;
const ENTITY_TYPES = ['contact', 'booking', 'job', 'quote', 'invoice', 'message'] as const;
type AuthType = (typeof AUTH_TYPES)[number];
type EntityType = (typeof ENTITY_TYPES)[number];

export interface ConnectorManifest {
  id: string;
  version: string;
  vendor: string;
  auth: AuthType;
  entities: EntityType[];
  requiredScopes: string[];
  webhookEvents: string[];
  configSchema: Record<string, { type: 'string' | 'number' | 'boolean'; required: boolean }>;
  featureFlag: string;
}

export type ConnectorManifestResult =
  | { ok: true; manifest: ConnectorManifest }
  | { ok: false; errors: ManifestIssue[] };

const CONNECTOR_KEYS = new Set(['id', 'version', 'vendor', 'auth', 'entities', 'requiredScopes', 'webhookEvents', 'configSchema', 'featureFlag']);
const FLAG_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_.:/-]{1,120}$/;
const CONFIG_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const CONFIG_TYPES = ['string', 'number', 'boolean'] as const;
const MAX_LIST = 50;

function stringList(value: unknown, path: string, errors: ManifestIssue[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) {
    errors.push({ path, message: `must be an array of at most ${MAX_LIST} strings` });
    return [];
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !TOKEN_PATTERN.test(item)) {
      errors.push({ path: `${path}.${index}`, message: 'must be a short token string' });
    } else out.push(item);
  });
  return out;
}

export function validateConnectorManifest(raw: unknown): ConnectorManifestResult {
  const errors: ManifestIssue[] = [];
  if (!isRecord(raw)) return { ok: false, errors: [{ path: '(root)', message: 'connector manifest must be a JSON object' }] };

  for (const key of Object.keys(raw)) {
    if (!CONNECTOR_KEYS.has(key)) errors.push({ path: key, message: 'unknown connector manifest key' });
  }
  if (typeof raw.id !== 'string' || !NAME_PATTERN.test(raw.id)) {
    errors.push({ path: 'id', message: 'must be kebab-case, 2 to 64 characters, starting with a letter' });
  }
  if (typeof raw.version !== 'string' || !SEMVER_PATTERN.test(raw.version)) {
    errors.push({ path: 'version', message: 'must be a semantic version, e.g. 0.1.0' });
  }
  boundedString(raw.vendor, 'vendor', 1, 120, errors);
  if (typeof raw.auth !== 'string' || !(AUTH_TYPES as readonly string[]).includes(raw.auth)) {
    errors.push({ path: 'auth', message: `must be one of ${AUTH_TYPES.join(', ')}` });
  }

  if (!Array.isArray(raw.entities) || raw.entities.length === 0) {
    errors.push({ path: 'entities', message: 'must be a non-empty array of entity types' });
  } else {
    raw.entities.forEach((entity, index) => {
      if (typeof entity !== 'string' || !(ENTITY_TYPES as readonly string[]).includes(entity)) {
        errors.push({ path: `entities.${index}`, message: `must be one of ${ENTITY_TYPES.join(', ')}` });
      }
    });
  }

  const requiredScopes = stringList(raw.requiredScopes ?? [], 'requiredScopes', errors);
  const webhookEvents = stringList(raw.webhookEvents ?? [], 'webhookEvents', errors);

  const configSchema: ConnectorManifest['configSchema'] = {};
  if (raw.configSchema !== undefined && !isRecord(raw.configSchema)) {
    errors.push({ path: 'configSchema', message: 'must be an object of field definitions' });
  } else if (isRecord(raw.configSchema)) {
    for (const [key, def] of Object.entries(raw.configSchema)) {
      if (!CONFIG_KEY_PATTERN.test(key)) errors.push({ path: `configSchema.${key}`, message: 'invalid field name' });
      if (!isRecord(def) || !(CONFIG_TYPES as readonly unknown[]).includes(def.type)) {
        errors.push({ path: `configSchema.${key}.type`, message: `must be one of ${CONFIG_TYPES.join(', ')}` });
        continue;
      }
      if (def.required !== undefined && typeof def.required !== 'boolean') {
        errors.push({ path: `configSchema.${key}.required`, message: 'must be a boolean' });
      }
      configSchema[key] = { type: def.type as ConnectorManifest['configSchema'][string]['type'], required: def.required === true };
    }
  }

  if (typeof raw.featureFlag !== 'string' || !FLAG_PATTERN.test(raw.featureFlag)) {
    errors.push({ path: 'featureFlag', message: 'must be a lowercase flag name, 3 to 64 characters' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      id: raw.id as string,
      version: raw.version as string,
      vendor: (raw.vendor as string).trim(),
      auth: raw.auth as AuthType,
      entities: [...(raw.entities as EntityType[])],
      requiredScopes,
      webhookEvents,
      configSchema,
      featureFlag: raw.featureFlag as string,
    },
  };
}
