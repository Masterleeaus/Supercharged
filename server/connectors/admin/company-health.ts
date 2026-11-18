/**
 * Loads one company's connector health (#353). Reads the registry list, the company settings, the per-company
 * state and the caller-supplied checks, then builds the health model from health.ts.
 *
 * Credentials are never read here: the caller passes `isConnected` (for example, a vault presence check) and
 * optional `tokenExpiresAt` and `deadLetterCount` lookups. Nothing in this file returns or logs a secret.
 *
 * Gap (kept on #353): no production deadLetterCount or tokenExpiresAt source is wired yet. Callers that do not
 * pass them get 0 and null, which the health view reports as "no dead letters" and "no expiry".
 */
import type { ConnectorRegistry } from '../registry.ts';
import type { SettingsStore } from '../registry.ts';
import type { ConnectorStateStore } from './state.ts';
import { buildCompanyHealth, type ConnectorHealth } from './health.ts';

export interface CompanyHealthDeps {
  registry: ConnectorRegistry;
  settings: SettingsStore;
  state: ConnectorStateStore;
  isConnected: (companyId: string, connectorId: string) => Promise<boolean>;
  tokenExpiresAt?: (companyId: string, connectorId: string) => Promise<string | null>;
  deadLetterCount?: (companyId: string, connectorId: string) => Promise<number>;
}

export async function loadCompanyHealth(deps: CompanyHealthDeps, companyId: string, nowIso: string): Promise<ConnectorHealth[]> {
  const entries = deps.registry.registered();
  const inputs = await Promise.all(
    entries.map(async (entry) => {
      const id = entry.manifest.id;
      const [settings, state, connected, expires, deadLetters] = await Promise.all([
        deps.settings.get(companyId, id),
        deps.state.get(companyId, id),
        deps.isConnected(companyId, id),
        deps.tokenExpiresAt ? deps.tokenExpiresAt(companyId, id) : Promise.resolve(null),
        deps.deadLetterCount ? deps.deadLetterCount(companyId, id) : Promise.resolve(0),
      ]);
      return {
        connectorId: id,
        displayName: entry.manifest.vendor || id,
        connected,
        enabled: settings?.enabled === true,
        paused: state.paused,
        lastSuccessAt: state.lastSuccessAt,
        errorCount: state.errorCount,
        lastErrorCode: state.lastErrorCode,
        deadLetterCount: deadLetters,
        tokenExpiresAt: expires,
      };
    }),
  );
  return buildCompanyHealth(inputs, nowIso);
}
