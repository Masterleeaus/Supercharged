/**
 * Connector registry (#350). Connectors come from manifests found by discovery, are matched to an
 * implementation, and register only when the implementation is consistent and the manifest's feature
 * flag is on. Each company enables a registered connector on its own. Everything defaults to off.
 *
 * Pure apart from the injected settings store and flag reader.
 */
import type { ConnectorDiscovery } from '../plugins/connector-discovery.ts';
import type { ConnectorManifest } from '../plugins/manifest.ts';
import { ConnectorError, checkConnectorDefinition, type ConnectorDefinition } from './sdk/contract.ts';

export interface CompanyConnectorSettings {
  enabled: boolean;
  config: Record<string, string | number | boolean>;
}

export interface SettingsStore {
  get(companyId: string, connectorId: string): Promise<CompanyConnectorSettings | null>;
  set(companyId: string, connectorId: string, settings: CompanyConnectorSettings): Promise<void>;
}

export function createMemorySettingsStore(): SettingsStore {
  const rows = new Map<string, CompanyConnectorSettings>();
  const key = (companyId: string, connectorId: string) => `${companyId}\u0000${connectorId}`;
  return {
    async get(companyId, connectorId) {
      const row = rows.get(key(companyId, connectorId));
      return row ? { enabled: row.enabled, config: { ...row.config } } : null;
    },
    async set(companyId, connectorId, settings) {
      rows.set(key(companyId, connectorId), { enabled: settings.enabled, config: { ...settings.config } });
    },
  };
}

export interface RegistryOptions {
  discovery: ConnectorDiscovery;
  implementations: Map<string, ConnectorDefinition>;
  isFlagOn: (flag: string) => boolean;
  settings: SettingsStore;
}

export interface RegisteredConnector {
  manifest: ConnectorManifest;
  definition: ConnectorDefinition;
}

export interface SkippedConnector {
  id: string;
  reason: string;
}

export interface ConnectorRegistry {
  registered(): RegisteredConnector[];
  skipped(): SkippedConnector[];
  get(id: string): RegisteredConnector | undefined;
  /** Throws unless the connector is registered and enabled for this company. Fails closed. */
  forCompany(companyId: string, id: string): Promise<RegisteredConnector>;
  enable(companyId: string, id: string, config: Record<string, unknown>): Promise<void>;
  disable(companyId: string, id: string): Promise<void>;
}

/** Checks config against the manifest's configSchema. Returns the problems; empty means valid. */
export function validateConnectorConfig(schema: ConnectorManifest['configSchema'], config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [key, def] of Object.entries(schema)) {
    if (config[key] === undefined) {
      if (def.required) problems.push(`${key} is required`);
      continue;
    }
    if (typeof config[key] !== def.type) problems.push(`${key} must be a ${def.type}`);
  }
  for (const key of Object.keys(config)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) problems.push(`${key} is not a known setting`);
  }
  return problems;
}

export function createConnectorRegistry(options: RegistryOptions): ConnectorRegistry {
  const registered = new Map<string, RegisteredConnector>();
  const skipped: SkippedConnector[] = [];

  for (const rejected of options.discovery.rejected) {
    skipped.push({ id: rejected.directory, reason: `invalid manifest: ${rejected.errors.map((e) => e.path).join(', ')}` });
  }

  for (const manifest of options.discovery.manifests) {
    const def = options.implementations.get(manifest.id);
    if (!def) {
      skipped.push({ id: manifest.id, reason: 'no implementation' });
      continue;
    }
    const problems = [
      ...checkConnectorDefinition(def),
      ...(def.id !== manifest.id ? ['implementation id does not match manifest'] : []),
      ...(def.auth !== manifest.auth ? ['implementation auth does not match manifest'] : []),
    ];
    if (problems.length > 0) {
      skipped.push({ id: manifest.id, reason: `implementation invalid: ${problems.join('; ')}` });
      continue;
    }
    if (!options.isFlagOn(manifest.featureFlag)) {
      skipped.push({ id: manifest.id, reason: 'feature flag off' });
      continue;
    }
    registered.set(manifest.id, { manifest, definition: def });
  }

  const requireRegistered = (id: string): RegisteredConnector => {
    const entry = registered.get(id);
    if (!entry) throw new ConnectorError('not_found', 'connector is not registered');
    return entry;
  };

  return {
    registered: () => [...registered.values()],
    skipped: () => [...skipped],
    get: (id) => registered.get(id),

    async forCompany(companyId, id) {
      const entry = requireRegistered(id);
      const settings = await options.settings.get(companyId, id);
      if (!settings || settings.enabled !== true) throw new ConnectorError('forbidden', 'connector is not enabled for this company');
      return entry;
    },

    async enable(companyId, id, config) {
      const entry = requireRegistered(id);
      const problems = validateConnectorConfig(entry.manifest.configSchema, config);
      if (problems.length > 0) throw new ConnectorError('validation', `invalid connector config: ${problems.join('; ')}`);
      await options.settings.set(companyId, id, {
        enabled: true,
        config: config as Record<string, string | number | boolean>,
      });
    },

    async disable(companyId, id) {
      requireRegistered(id);
      const current = await options.settings.get(companyId, id);
      await options.settings.set(companyId, id, { enabled: false, config: current?.config ?? {} });
    },
  };
}
