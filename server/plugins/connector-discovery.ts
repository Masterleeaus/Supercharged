/**
 * Finds connector manifests (plugins/<name>/connector.json) under a root directory (#350).
 * Each manifest is validated on its own. A bad one is reported and skipped; the rest still load.
 * No database and no imports of connector code: discovery only reads and validates JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateConnectorManifest, type ConnectorManifest, type ManifestIssue } from './manifest.ts';

export interface RejectedConnector {
  directory: string;
  errors: ManifestIssue[];
}

export interface ConnectorDiscovery {
  manifests: ConnectorManifest[];
  rejected: RejectedConnector[];
}

export function discoverConnectorManifests(root: string): ConnectorDiscovery {
  const result: ConnectorDiscovery = { manifests: [], rejected: [] };
  if (!fs.existsSync(root)) return result;
  const seen = new Set<string>();

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = path.join(root, entry.name, 'connector.json');
    if (!fs.existsSync(file)) continue;
    if (fs.lstatSync(file).isSymbolicLink()) {
      result.rejected.push({ directory: entry.name, errors: [{ path: '(file)', message: 'symlinked manifest refused' }] });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      result.rejected.push({ directory: entry.name, errors: [{ path: '(file)', message: 'manifest is not valid JSON' }] });
      continue;
    }
    const checked = validateConnectorManifest(parsed);
    if ('errors' in checked) {
      result.rejected.push({ directory: entry.name, errors: checked.errors });
      continue;
    }
    if (checked.manifest.id !== entry.name) {
      result.rejected.push({ directory: entry.name, errors: [{ path: 'id', message: 'must match the directory name' }] });
      continue;
    }
    if (seen.has(checked.manifest.id)) {
      result.rejected.push({ directory: entry.name, errors: [{ path: 'id', message: 'duplicate connector id' }] });
      continue;
    }
    seen.add(checked.manifest.id);
    result.manifests.push(checked.manifest);
  }
  return result;
}
