/*
 * Desk-side contracts for the decision engine. Types, plus one fail-closed
 * default. The engine core (src/) never sees a company it was not given; the
 * adapter in index.ts binds company_id before any core call.
 */

import type { DecisionHistoryEntry } from "./src/engines/24-decision-history/runtime/decisionHistory.js";
import type { PreparedHostActionRequest } from "./src/engines/27-action-handoff/runtime/decisionActionHandoff.js";
import type {
  DecisionWorkflowStage,
  DecisionWorkflowStageAdapter,
} from "./src/engines/26-decision-workflow/runtime/decisionWorkflow.js";

/**
 * Persistence Desk must implement. The adapter always passes the company it was
 * bound to; implementations must scope every read and write to that company.
 */
export interface DeskDecisionPersistence {
  /** Latest stored revision for one decision, or null when none exists. */
  loadLatestHistory(companyId: string, decisionId: string): Promise<DecisionHistoryEntry | null>;
  /** Stores one new revision. Called once per decision run, after the workflow stages. */
  appendHistory(companyId: string, entry: DecisionHistoryEntry): Promise<void>;
}

/** Receipt returned by a host dispatch. */
export interface DeskDispatchReceipt {
  dispatch_id: string;
  dispatched_at: string;
}

/**
 * Dispatch Desk must implement for approved action requests. The decision engine
 * never calls this: step 27 only prepares a request with dispatch_state "not_dispatched".
 */
export interface DeskDispatch {
  dispatch(request: PreparedHostActionRequest): Promise<DeskDispatchReceipt>;
}

/** Clock Desk may inject. Returns an ISO-8601 instant. */
export type DeskClock = () => string;

/** Stage adapters Desk supplies for every workflow stage except `history`, which the adapter owns. */
export type DeskStageAdapters = Omit<
  Record<DecisionWorkflowStage, DecisionWorkflowStageAdapter>,
  "history"
>;

export interface DeskDecisionDependencies {
  /** Omit to get the fail-closed default: the decision is refused before any stage runs. */
  persistence?: DeskDecisionPersistence;
  stages: DeskStageAdapters;
  clock?: DeskClock;
}

export class DeskDecisionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "DeskDecisionError";
  }
}

/**
 * Default persistence when none is injected. Every method refuses, so a decision
 * cannot be recorded and the adapter refuses to start one.
 */
const refuse = async (): Promise<never> => {
  throw new DeskDecisionError("persistence_not_injected");
};

export const REFUSING_PERSISTENCE: DeskDecisionPersistence = Object.freeze({
  loadLatestHistory: refuse,
  appendHistory: refuse,
});
