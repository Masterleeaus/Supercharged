#!/usr/bin/env node
/**
 * Generates a new engine from server/engines/_template.
 *
 * Usage:
 *   node scripts/new-engine.mjs <engine-name> <provider-name> [--version <semver>] [--root <dir>]
 *
 * Name rules: lower-case letters, digits and single hyphens, starting with a letter.
 * --root defaults to the repository that contains this script. Tests pass a temp directory.
 * Output: <root>/server/engines/<engine-name>/. Refuses to overwrite. Rolls back on failure.
 *
 * Name tokens replaced in every text file:
 *   __ENGINE_NAME__      engine name, e.g. billing
 *   __ENGINE_PASCAL__    Billing
 *   __ENGINE_ENV__       BILLING (used in TITAN_ENGINE_BILLING_ENABLED)
 *   __ENGINE_VERSION__   engine version
 *   __PROVIDER_NAME__    provider name, e.g. stripe
 *   __PROVIDER_PASCAL__  Stripe
 * The folder segment gateways/_provider is renamed to gateways/<provider>.
 *
 * Node built-ins only.
 */

import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const LEFTOVER_RE = /__(ENGINE|PROVIDER)_[A-Z_]+__|gateways\/_provider/;
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_REL = join('server', 'engines', '_template');
const PROVIDER_DIR_TEMPLATE = join('gateways', '_provider');

function pascal(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function buildTokens({ engine, provider, version }) {
  return [
    ['__ENGINE_NAME__', engine],
    ['__ENGINE_PASCAL__', pascal(engine)],
    ['__ENGINE_ENV__', engine.toUpperCase().replace(/-/g, '_')],
    ['__ENGINE_VERSION__', version],
    ['__PROVIDER_NAME__', provider],
    ['__PROVIDER_PASCAL__', pascal(provider)],
  ];
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function generateEngine({ root = DEFAULT_ROOT, engine, provider, version = '0.1.0' }) {
  if (!NAME_RE.test(engine)) {
    throw new Error(`Invalid engine name "${engine}". Use lower-case letters, digits and single hyphens.`);
  }
  if (!NAME_RE.test(provider)) {
    throw new Error(`Invalid provider name "${provider}". Use lower-case letters, digits and single hyphens.`);
  }
  if (engine.startsWith('_') || provider.startsWith('_')) {
    throw new Error('Names must not start with an underscore.');
  }
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid version "${version}". Expected semver, e.g. 0.1.0.`);
  }

  const templateDir = join(root, TEMPLATE_REL);
  if (!existsSync(templateDir) || !statSync(templateDir).isDirectory()) {
    throw new Error(`Template not found: ${templateDir}`);
  }

  const targetDir = join(root, 'server', 'engines', engine);
  if (existsSync(targetDir)) {
    throw new Error(`Refusing to overwrite existing engine: ${targetDir}`);
  }

  const tokens = buildTokens({ engine, provider, version });

  try {
    cpSync(templateDir, targetDir, { recursive: true, errorOnExist: true, force: false });

    const providerTemplate = join(targetDir, PROVIDER_DIR_TEMPLATE);
    const providerTarget = join(targetDir, 'gateways', provider);
    if (!existsSync(providerTemplate)) {
      throw new Error(`Provider skeleton missing in template: ${PROVIDER_DIR_TEMPLATE}`);
    }
    renameSync(providerTemplate, providerTarget);

    for (const file of walkFiles(targetDir)) {
      const original = readFileSync(file, 'utf8');
      let next = original;
      for (const [token, value] of tokens) {
        next = next.split(token).join(value);
      }
      next = next.split('gateways/_provider').join(`gateways/${provider}`);
      if (file === join(targetDir, 'VERSION')) {
        next = `${version}\n`;
      }
      if (next !== original) {
        writeFileSync(file, next, 'utf8');
      }
    }

    for (const file of walkFiles(targetDir)) {
      const text = readFileSync(file, 'utf8');
      if (LEFTOVER_RE.test(text)) {
        throw new Error(`Placeholder left in ${file}`);
      }
    }
    if (existsSync(join(targetDir, 'gateways', '_provider'))) {
      throw new Error('Provider folder was not renamed');
    }
  } catch (error) {
    rmSync(targetDir, { recursive: true, force: true });
    throw error;
  }

  return { targetDir, files: walkFiles(targetDir).map((f) => f.slice(targetDir.length + 1)) };
}

function parseArgs(argv) {
  const positional = [];
  const opts = { root: DEFAULT_ROOT, version: '0.1.0' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--version') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      opts[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    throw new Error('Usage: node scripts/new-engine.mjs <engine-name> <provider-name> [--version <semver>] [--root <dir>]');
  }
  return { engine: positional[0], provider: positional[1], root: resolve(opts.root), version: opts.version };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = generateEngine(args);
  console.log(`Created ${result.targetDir}`);
  for (const file of result.files) {
    console.log(`  ${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`new-engine: ${error.message}`);
    process.exit(1);
  }
}
