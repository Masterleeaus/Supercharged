/**
 * Plain-language messages and suggested fixes for connector failures (#353). Every failure code the SDK
 * or the sync engine can produce has an entry, so the admin view never shows a raw code without a fix.
 *
 * Pure: static text only. Messages never include vendor responses, tokens or record contents.
 */
import { ERROR_CODES, type ConnectorErrorCode } from '../sdk/contract.ts';

export type HealthCode = 'token_expiring' | 'token_expired' | 'dead_letters' | 'never_synced' | 'not_connected' | 'paused';

export interface FailureGuide {
  message: string;
  fix: string;
}

export const FAILURE_GUIDE: Record<ConnectorErrorCode | 'validation' | 'conflict_manual' | 'unknown' | HealthCode, FailureGuide> = {
  auth: {
    message: 'The tool no longer accepts our login.',
    fix: 'Reconnect the tool from the connect screen. If it keeps failing, check that the account still has access.',
  },
  forbidden: {
    message: 'The tool refused this action for the connected account.',
    fix: 'Check the permissions granted to the connected account in the tool, then run Test again.',
  },
  not_found: {
    message: 'The tool could not find a record we expected.',
    fix: 'The record was probably deleted in the tool. Check it there; no action is needed in Supercharged if it was removed on purpose.',
  },
  validation: {
    message: 'The tool rejected a change because its data did not match what it expects.',
    fix: 'Open the failed item in the admin view, correct the field it names, and retry it.',
  },
  conflict: {
    message: 'The tool reported that the record changed at the same time.',
    fix: 'Retry the item. If it fails again, compare the two copies and keep the one you want.',
  },
  conflict_manual: {
    message: 'Both Supercharged and the tool changed this record, and the two copies differ.',
    fix: 'Choose which copy to keep in the admin view, then retry the item.',
  },
  rate_limited: {
    message: 'The tool asked us to slow down.',
    fix: 'Nothing to do. Supercharged waits and retries. If it repeats, sync less often in the connector settings.',
  },
  timeout: {
    message: 'The tool took too long to answer.',
    fix: 'Nothing to do. Supercharged retries. If it repeats, check the tool status page.',
  },
  upstream: {
    message: 'The tool had a server problem.',
    fix: 'Nothing to do. Supercharged retries automatically. If the problem lasts more than an hour, check the tool status page.',
  },
  unknown: {
    message: 'Something unexpected stopped this change.',
    fix: 'Retry the item once. If it fails again, contact support with the reference shown in the admin view.',
  },
  token_expiring: {
    message: 'The connection expires within a day.',
    fix: 'It refreshes on its own. If it does not refresh, reconnect the tool before it expires.',
  },
  token_expired: {
    message: 'The connection has expired and cannot refresh.',
    fix: 'Reconnect the tool from the connect screen.',
  },
  dead_letters: {
    message: 'Some changes did not sync and are waiting in the dead-letter queue.',
    fix: 'Open the queue, fix or confirm each item, and retry it.',
  },
  never_synced: {
    message: 'This tool is connected but has not synced yet.',
    fix: 'Run Test. If the test passes, the first sync will run on its next schedule.',
  },
  not_connected: {
    message: 'This tool is not connected.',
    fix: 'Connect it from the connect screen.',
  },
  paused: {
    message: 'Syncing for this tool is paused.',
    fix: 'Resume it when you are ready. Nothing is lost while it is paused.',
  },
};

/** Every error code the SDK defines has a guide entry. Checked by the test suite. */
export const GUIDED_ERROR_CODES: readonly string[] = ERROR_CODES;

export function guideFor(code: string): FailureGuide {
  return Object.prototype.hasOwnProperty.call(FAILURE_GUIDE, code)
    ? FAILURE_GUIDE[code as keyof typeof FAILURE_GUIDE]
    : FAILURE_GUIDE.unknown;
}
