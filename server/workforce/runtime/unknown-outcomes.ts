/**
 * Resolution of an action whose outcome is unknown (for example a timeout after the request left the process).
 *
 * Order of evidence:
 * 1. Read the real record back. If it shows the change, the action was applied. If it shows the prior state,
 *    it was not applied.
 * 2. If the read-back shows neither state, or the read-back itself fails, the outcome stays unknown. The owner
 *    is notified and decides. Nothing is retried here.
 *
 * Pure orchestration: the read-back, owner notice and record sink are injected. No database, no network.
 */
import { isDeepStrictEqual } from 'node:util';

export interface UnknownOutcomeChange {
  /** Value the record held before the action was attempted. */
  before: unknown;
  /** Value the record should hold if the action was applied. */
  after: unknown;
  /** Free-form identifier used in notices and records (for example a booking or message id). */
  [key: string]: unknown;
}

export type UnknownOutcomeResolution = 'applied' | 'not_applied' | 'owner_decides';

export interface UnknownOutcomeDeps {
  /** Reads the current value of the record the change targets. */
  readBack: (change: UnknownOutcomeChange) => Promise<unknown> | unknown;
  /** Tells the owner the outcome could not be confirmed. Called only for 'owner_decides'. */
  notifyOwner: (change: UnknownOutcomeChange) => Promise<unknown> | unknown;
  /** Receives the resolution once it is known. Called for every branch. */
  record: (resolution: UnknownOutcomeResolution, change: UnknownOutcomeChange) => Promise<unknown> | unknown;
}

export async function resolveUnknownOutcome(
  deps: UnknownOutcomeDeps,
  change: UnknownOutcomeChange,
): Promise<UnknownOutcomeResolution> {
  let observed: unknown;
  let readFailed = false;
  try {
    observed = await deps.readBack(change);
  } catch {
    readFailed = true;
  }

  let resolution: UnknownOutcomeResolution;
  if (!readFailed && isDeepStrictEqual(observed, change.after)) {
    resolution = 'applied';
  } else if (!readFailed && isDeepStrictEqual(observed, change.before)) {
    resolution = 'not_applied';
  } else {
    resolution = 'owner_decides';
    await deps.notifyOwner(change);
  }

  await deps.record(resolution, change);
  return resolution;
}
