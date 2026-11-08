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
