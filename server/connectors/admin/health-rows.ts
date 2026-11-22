/**
 * One-column row model for the connector health view (#353). A tablet screen shows one row per connector, in the
 * order buildCompanyHealth gives (worst first). Pure: a UI component maps these rows to markup without logic.
 */
import type { ConnectorHealth, HealthState } from './health.ts';

export type HealthTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface HealthRow {
  connectorId: string;
  title: string;
  stateLabel: string;
  tone: HealthTone;
  facts: string[];
  problems: { message: string; fix: string }[];
}

const STATE_LABEL: Record<HealthState, string> = {
  failing: 'Failing',
  attention: 'Needs attention',
  paused: 'Paused',
  not_connected: 'Not connected',
  healthy: 'Healthy',
};

const TONE: Record<HealthState, HealthTone> = {
  failing: 'bad',
  attention: 'warn',
  paused: 'muted',
  not_connected: 'muted',
  healthy: 'ok',
};

export function toHealthRows(healths: ConnectorHealth[]): HealthRow[] {
  return healths.map((h) => ({
    connectorId: h.connectorId,
    title: h.displayName,
    stateLabel: STATE_LABEL[h.state],
    tone: TONE[h.state],
    facts: [
      `Last successful sync: ${h.lastSuccessAt ?? 'never'}`,
      `Errors: ${h.errorCount}`,
      `Dead letters: ${h.deadLetterCount}`,
      `Token expires: ${h.tokenExpiresAt ?? 'no expiry on record'}`,
    ],
    problems: h.problems.map((p) => ({ message: p.message, fix: p.fix })),
  }));
}
