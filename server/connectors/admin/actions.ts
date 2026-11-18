/**
 * Admin actions for connectors (#353): connect, test, pause, resume and disconnect. Each action goes through
 * the registry (which fails closed), the credential vault and the shared runner, so admin screens never touch
 * credentials directly. Returns plain results with guided messages; never returns credentials.
 */
import { ConnectorError, type ConnectorCredentials, type ActionDefinition } from '../sdk/contract.ts';
import { runAction } from '../sdk/runner.ts';
import type { AuditSink } from '../sdk/audit.ts';
import type { ConnectorRegistry } from '../registry.ts';
import type { CredentialVault } from '../vault/credential-vault.ts';
import { guideFor, type FailureGuide } from './failure-guide.ts';
import type { ConnectorStateStore } from './state.ts';
import type { SyncEngine, PushFn } from '../sync/engine.ts';
import type { DeadLetter, ReasonCode } from '../sync/stores.ts';

/** A dead letter as the admin view shows it. No event payload, so no vendor or customer data leaks into the list. */
export interface DeadLetterSummary {
  id: string;
  connectorId: string;
  direction: 'inbound' | 'outbound';
  entity: string;
  eventId: string;
  reason: ReasonCode;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export type ReplayOutcome = 'replayed' | 'failed' | 'not_found';

export interface AdminDeps {
  registry: ConnectorRegistry;
  vault: CredentialVault;
  state: ConnectorStateStore;
  audit: AuditSink;
  /** Sync engine that owns the dead-letter queue (#352). Needed for the dead-letter actions. */
  sync?: SyncEngine;
  /** Vendor push for outbound dead letters. Server-side only; without it an outbound replay fails closed. */
  pushFor?: (companyId: string, connectorId: string) => PushFn;
  /** Returns usable credentials, refreshing OAuth tokens when needed. */
  credentialsFor: (companyId: string, connectorId: string) => Promise<ConnectorCredentials>;
  /** Starts an OAuth connect and returns the authorize URL. Only for connectors that use oauth2. */
  beginOAuth?: (companyId: string, connectorId: string) => Promise<{ url: string }>;
  /** Revokes at the provider where supported. The local copy is removed by disconnect either way. */
  revokeOAuth?: (companyId: string, connectorId: string) => Promise<unknown>;
  now?: () => Date;
}

export type TestResult =
  | { ok: true; checkedAt: string }
  | { ok: false; code: string; guide: FailureGuide; checkedAt: string };

export function createConnectorAdmin(deps: AdminDeps) {
  const now = deps.now ?? (() => new Date());

  const entryOrThrow = (connectorId: string) => {
    const entry = deps.registry.get(connectorId);
    if (!entry) throw new ConnectorError('not_found', 'connector is not registered');
    return entry;
  };

  const syncOrThrow = (): SyncEngine => {
    if (!deps.sync) throw new ConnectorError('validation', 'sync engine is not configured');
    return deps.sync;
  };

  const summarize = (letter: DeadLetter): DeadLetterSummary => ({
    id: letter.id,
    connectorId: letter.connectorId,
    direction: letter.direction,
    entity: String(letter.event.entity),
    eventId: letter.eventId,
    reason: letter.reason,
    attempts: letter.attempts,
    createdAt: letter.createdAt,
    updatedAt: letter.updatedAt,
  });

  return {
    /** Lists the dead-lettered sync changes for one connector of one company (#352). Payloads are not returned. */
    async deadLetters(companyId: string, connectorId: string): Promise<DeadLetterSummary[]> {
      const sync = syncOrThrow();
      entryOrThrow(connectorId);
      return (await sync.deadLetters(companyId, connectorId)).map(summarize);
    },

    /**
     * Replays one dead letter from the admin view (#352). The letter must belong to this company and connector;
     * anything else reports not_found. Replay itself is at most once (see the sync engine).
     */
    async replayDeadLetter(companyId: string, connectorId: string, deadLetterId: string): Promise<{ status: ReplayOutcome }> {
      const sync = syncOrThrow();
      entryOrThrow(connectorId);
      const owned = (await sync.deadLetters(companyId, connectorId)).some((l) => l.id === deadLetterId);
      if (!owned) return { status: 'not_found' };
      const push = deps.pushFor?.(companyId, connectorId);
      return { status: await sync.replay(companyId, deadLetterId, push) };
    },

    /** Connects an api_key connector: stores the key in the vault, then enables it for the company. */
    async connectApiKey(companyId: string, connectorId: string, apiKey: string, config: Record<string, unknown>) {
      const entry = entryOrThrow(connectorId);
      if (entry.definition.auth !== 'api_key') throw new ConnectorError('validation', 'connector does not use an API key');
      await deps.vault.save(companyId, connectorId, { type: 'api_key', apiKey });
      await deps.registry.enable(companyId, connectorId, config);
      await deps.state.clear(companyId, connectorId);
      return { connected: true as const };
    },

    /** Starts an OAuth connect. The returned URL carries no tokens. */
    async startOAuth(companyId: string, connectorId: string) {
      const entry = entryOrThrow(connectorId);
      if (entry.definition.auth !== 'oauth2' || !deps.beginOAuth) throw new ConnectorError('validation', 'connector does not use OAuth');
      return deps.beginOAuth(companyId, connectorId);
    },

    /** Runs the connector's first read action against the vendor and records the outcome. */
    async test(companyId: string, connectorId: string): Promise<TestResult> {
      const entry = await deps.registry.forCompany(companyId, connectorId);
      const checkedAt = now().toISOString();
      if ((await deps.state.get(companyId, connectorId)).paused) {
        throw new ConnectorError('forbidden', 'connector is paused');
      }
      const readAction = Object.entries(entry.definition.actions).find(
        ([, spec]: [string, ActionDefinition]) => spec.kind === 'read',
      );
      if (!readAction) throw new ConnectorError('validation', 'connector has no read action to test');
      try {
        const credentials = await deps.credentialsFor(companyId, connectorId);
        await runAction({
          definition: entry.definition,
          companyId,
          action: readAction[0],
          input: {},
          credentials,
          audit: deps.audit,
          now,
        });
        await deps.state.update(companyId, connectorId, (s) => ({ ...s, lastSuccessAt: checkedAt, lastErrorCode: null }));
        return { ok: true, checkedAt };
      } catch (err) {
        const code = err instanceof ConnectorError ? err.code : 'unknown';
        await deps.state.update(companyId, connectorId, (s) => ({ ...s, lastErrorCode: code, errorCount: s.errorCount + 1 }));
        return { ok: false, code, guide: guideFor(code), checkedAt };
      }
    },

    /** Pauses syncing. Credentials and the enabled setting are kept, so resume needs no reconnect. */
    async pause(companyId: string, connectorId: string) {
      entryOrThrow(connectorId);
      await deps.state.update(companyId, connectorId, (s) => ({ ...s, paused: true }));
      return { paused: true as const };
    },

    async resume(companyId: string, connectorId: string) {
      entryOrThrow(connectorId);
      await deps.state.update(companyId, connectorId, (s) => ({ ...s, paused: false }));
      return { paused: false as const };
    },

    /** Removes credentials, disables the connector and clears its state. */
    async disconnect(companyId: string, connectorId: string) {
      const entry = entryOrThrow(connectorId);
      if (entry.definition.auth === 'oauth2' && deps.revokeOAuth) {
        await deps.revokeOAuth(companyId, connectorId);
      } else {
        await deps.vault.remove(companyId, connectorId);
      }
      await deps.registry.disable(companyId, connectorId);
      await deps.state.clear(companyId, connectorId);
      return { connected: false as const };
    },
  };
}
