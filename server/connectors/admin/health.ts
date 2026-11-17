/**
 * Health view for one company's connectors (#353): last successful sync, error count, dead-letter count and
 * token expiry, with a state and plain-language problems. Pure: the caller loads the inputs.
 */
import { guideFor, type FailureGuide, type HealthCode } from './failure-guide.ts';

export const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

export interface ConnectorHealthInput {
  connectorId: string;
  displayName: string;
  connected: boolean;
  enabled: boolean;
  paused: boolean;
  lastSuccessAt: string | null;
  errorCount: number;
  lastErrorCode: string | null;
  deadLetterCount: number;
  tokenExpiresAt: string | null;
}

export type HealthState = 'not_connected' | 'paused' | 'healthy' | 'attention' | 'failing';

export interface HealthProblem extends FailureGuide {
  code: string;
}

export interface ConnectorHealth {
  connectorId: string;
  displayName: string;
  state: HealthState;
  lastSuccessAt: string | null;
  errorCount: number;
  deadLetterCount: number;
  tokenExpiresAt: string | null;
  problems: HealthProblem[];
}

const RANK: Record<HealthState, number> = { failing: 0, attention: 1, paused: 2, not_connected: 3, healthy: 4 };

function problem(code: HealthCode | string, guide?: FailureGuide): HealthProblem {
  const g = guide ?? guideFor(code);
  return { code, message: g.message, fix: g.fix };
}

export function buildConnectorHealth(input: ConnectorHealthInput, nowIso: string): ConnectorHealth {
  const now = Date.parse(nowIso);
  const problems: HealthProblem[] = [];
  let state: HealthState = 'healthy';
  const raise = (to: HealthState, p: HealthProblem) => {
    problems.push(p);
    if (RANK[to] < RANK[state]) state = to;
  };

  if (!input.connected) {
    raise('not_connected', problem('not_connected'));
  } else {
    if (input.paused) raise('paused', problem('paused'));

    if (input.tokenExpiresAt !== null) {
      const expires = Date.parse(input.tokenExpiresAt);
      if (expires <= now) raise('failing', problem('token_expired'));
      else if (expires - now <= EXPIRY_WARNING_MS) raise('attention', problem('token_expiring'));
    }
    if (input.lastErrorCode !== null) raise('failing', problem(input.lastErrorCode));
    if (input.deadLetterCount > 0) raise('attention', problem('dead_letters'));
    if (input.lastSuccessAt === null && input.enabled && !input.paused) raise('attention', problem('never_synced'));
  }

  return {
    connectorId: input.connectorId,
    displayName: input.displayName,
    state,
    lastSuccessAt: input.lastSuccessAt,
    errorCount: input.errorCount,
    deadLetterCount: input.deadLetterCount,
    tokenExpiresAt: input.tokenExpiresAt,
    problems,
  };
}

/** Health for every connector of a company, worst first, ties broken by name. */
export function buildCompanyHealth(inputs: ConnectorHealthInput[], nowIso: string): ConnectorHealth[] {
  return inputs
    .map((i) => buildConnectorHealth(i, nowIso))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || a.displayName.localeCompare(b.displayName));
}
