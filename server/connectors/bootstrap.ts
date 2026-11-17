/**
 * Startup wiring for connectors (#350). Discovers connector manifests from every directory that holds them,
 * pairs each with its implementation, and builds the registry. Nothing registers without its feature flag,
 * and an invalid manifest blocks only that connector.
 *
 * Manifest roots are fixed here so a connector cannot be added to a root the registry never reads. Each root
 * is scanned one level deep for <dir>/connector.json. Ids must be unique across all roots.
 *
 * Pure apart from the directory reads done by discovery. The caller supplies the HTTP clients and settings store.
 */
import path from 'node:path';
import type { HttpClient } from '../modules/chatbot/contracts/http.ts';
import { discoverConnectorManifests, type ConnectorDiscovery, type RejectedConnector } from '../plugins/connector-discovery.ts';
import { createFieldServiceImplementations } from './providers/index.ts';
import { createGoogleCalendarConnector } from './calendar/google-calendar.ts';
import { createOutlookCalendarConnector } from './calendar/outlook.ts';
import { createCalendlyConnector } from './calendar/calendly.ts';
import { createTwilioConnector } from './twilio/index.ts';
import type { ConnectorDefinition } from './sdk/contract.ts';
import { createConnectorRegistry, type ConnectorRegistry, type SettingsStore } from './registry.ts';

/** Directories, relative to the repository root, that hold connector manifests. */
export const CONNECTOR_MANIFEST_DIRS: readonly string[] = [
  'plugins',
  path.join('server', 'connectors', 'manifests'),
  path.join('server', 'connectors', 'catalog'),
  path.join('server', 'connectors'),
];

/** Discovers manifests from every root. A duplicate id in a later root is rejected, the first one is kept. */
export function discoverAllConnectorManifests(repoRoot: string, dirs: readonly string[] = CONNECTOR_MANIFEST_DIRS): ConnectorDiscovery {
  const merged: ConnectorDiscovery = { manifests: [], rejected: [] };
  const seen = new Set<string>();
  for (const dir of dirs) {
    const found = discoverConnectorManifests(path.join(repoRoot, dir));
    merged.rejected.push(...found.rejected.map((r): RejectedConnector => ({ ...r, directory: path.join(dir, r.directory) })));
    for (const manifest of found.manifests) {
      if (seen.has(manifest.id)) {
        merged.rejected.push({ directory: path.join(dir, manifest.id), errors: [{ path: 'id', message: 'duplicate connector id' }] });
        continue;
      }
      seen.add(manifest.id);
      merged.manifests.push(manifest);
    }
  }
  return merged;
}

export interface ImplementationDeps {
  /** Used by the calendar connectors. */
  http: HttpClient;
  /** Used by the field-service and Twilio connectors. */
  fetch: typeof fetch;
  jobberApiVersion: string;
}

/** Every connector implementation the server ships, keyed by its id. */
export function createConnectorImplementations(deps: ImplementationDeps): Map<string, ConnectorDefinition> {
  const implementations = createFieldServiceImplementations({ fetch: deps.fetch, jobberApiVersion: deps.jobberApiVersion });
  const others: ConnectorDefinition[] = [
    createGoogleCalendarConnector({ http: deps.http }),
    createOutlookCalendarConnector({ http: deps.http }),
    createCalendlyConnector({ http: deps.http }),
    createTwilioConnector({ fetchImpl: deps.fetch }),
  ];
  for (const def of others) implementations.set(def.id, def);
  return implementations;
}

export interface ConnectorBootstrapOptions {
  repoRoot: string;
  implementations: Map<string, ConnectorDefinition>;
  isFlagOn: (flag: string) => boolean;
  settings: SettingsStore;
  dirs?: readonly string[];
}

export function buildConnectorRegistry(options: ConnectorBootstrapOptions): ConnectorRegistry {
  return createConnectorRegistry({
    discovery: discoverAllConnectorManifests(options.repoRoot, options.dirs),
    implementations: options.implementations,
    isFlagOn: options.isFlagOn,
    settings: options.settings,
  });
}
