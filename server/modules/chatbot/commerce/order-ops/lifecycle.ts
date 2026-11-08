/**
 * Lifecycle of the commerce extension for one company: enabled, disabled, uninstalling, uninstalled.
 * Port of CommerceLifecycleRuntime.php and Support/LifecycleStatus.php.
 *
 * Rules, each recorded in DECISIONS.md:
 *  - Transitions are checked. The PHP code wrote any status over any other. Here an illegal move throws a 409 and
 *    writes nothing. The allowed moves are in LIFECYCLE_TRANSITIONS.
 *  - Asking for the status a company is already in is a no-op and returns the current state.
 *  - Data is always preserved. Nothing in this runtime deletes order, customer or stock data.
 *  - Each change is saved with an outbox event in the same save. A publish failure never undoes the change.
 *  - State is kept per company. PHP keeps one row for the whole install. The owner may choose otherwise.
 *  - A company with no row is treated as enabled, as the PHP status() does.
 */
import { requireCompanyId } from "../../chatbot-scope.ts";
import { OrderOpsError } from "./types.ts";

export const LIFECYCLE_EXTENSION_KEY = "chatbot-ecommerce";
export const LIFECYCLE_STATUSES = ["enabled", "disabled", "uninstalling", "uninstalled"] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/** Only these moves are allowed. Any other pair is refused. */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<LifecycleStatus, readonly LifecycleStatus[]>> = {
  enabled: ["disabled", "uninstalling"],
  disabled: ["enabled", "uninstalling"],
  uninstalling: ["enabled", "uninstalled"],
  uninstalled: ["enabled"],
};

export function canLifecycleTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export interface LifecycleState {
  companyId: string;
  extensionKey: typeof LIFECYCLE_EXTENSION_KEY;
  status: LifecycleStatus;
  installedVersion: string | null;
  preserveData: true;
  reason: string | null;
  enabledAt: Date | null;
  disabledAt: Date | null;
  uninstallStartedAt: Date | null;
  uninstalledAt: Date | null;
}

export interface LifecycleEvent {
  topic: "commerce.lifecycle.changed";
  dedupeKey: string;
  from: LifecycleStatus | null;
  to: LifecycleStatus;
  reason: string | null;
  occurredAt: Date;
}

/**
 * Storage port for the lifecycle state. save() writes the state and its event together, so a caller never sees one
 * without the other. The Drizzle version needs a table that does not exist yet (see DECISIONS.md, change request).
 */
export interface LifecycleStateStore {
  get(companyId: string): Promise<LifecycleState | null>;
  save(companyId: string, state: LifecycleState, event: LifecycleEvent): Promise<void>;
}

export interface LifecycleDeps {
  states: LifecycleStateStore;
  now?: () => Date;
}

/** In-memory state store. Events are kept in a list so a test can check that every change wrote one. */
export interface MemoryLifecycleStore extends LifecycleStateStore {
  readonly events: Array<LifecycleEvent & { companyId: string }>;
}

export function createMemoryLifecycleStore(): MemoryLifecycleStore {
  const rows = new Map<string, LifecycleState>();
  const events: Array<LifecycleEvent & { companyId: string }> = [];
  return {
    events,
    async get(companyId) {
      const scope = requireCompanyId(companyId);
      const row = rows.get(scope);
      return row && row.companyId === scope ? structuredClone(row) : null;
    },
    async save(companyId, state, event) {
      const scope = requireCompanyId(companyId);
      if (state.companyId !== scope) throw new OrderOpsError("Lifecycle state belongs to another company.", 404);
      rows.set(scope, structuredClone(state));
      events.push(structuredClone({ ...event, companyId: scope }));
    },
  };
}

export function createCommerceLifecycle(deps: LifecycleDeps) {
  const now = deps.now ?? (() => new Date());

  function implicitState(companyId: string): LifecycleState {
    return {
      companyId,
      extensionKey: LIFECYCLE_EXTENSION_KEY,
      status: "enabled",
      installedVersion: null,
      preserveData: true,
      reason: null,
      enabledAt: null,
      disabledAt: null,
      uninstallStartedAt: null,
      uninstalledAt: null,
    };
  }

  async function current(companyId: string): Promise<LifecycleState> {
    const scope = requireCompanyId(companyId);
    return (await deps.states.get(scope)) ?? implicitState(scope);
  }

  async function save(companyId: string, next: LifecycleState, from: LifecycleStatus | null, reason: string | null, at: Date): Promise<LifecycleState> {
    const event: LifecycleEvent = {
      topic: "commerce.lifecycle.changed",
      dedupeKey: `lifecycle:${companyId}:${from ?? "none"}:${next.status}:${at.toISOString()}`,
      from,
      to: next.status,
      reason,
      occurredAt: at,
    };
    await deps.states.save(companyId, next, event);
    return next;
  }

  /** Moves to `to`. Same-state requests return the current state. Other pairs must be in the transition table. */
  async function move(companyId: string, to: LifecycleStatus, options: { version?: string; reason?: string | null }): Promise<LifecycleState> {
    const scope = requireCompanyId(companyId);
    const existing = await deps.states.get(scope);
    const before = existing ?? implicitState(scope);
    if (before.status === to) return before;
    if (!canLifecycleTransition(before.status, to)) {
      throw new OrderOpsError(`The commerce extension cannot move from ${before.status} to ${to}.`, 409);
    }
    const at = now();
    const reason = options.reason ?? null;
    const next: LifecycleState = { ...before, status: to, preserveData: true, reason };
    if (options.version !== undefined) next.installedVersion = options.version;
    if (to === "enabled") {
      next.enabledAt = at;
      next.disabledAt = null;
      next.uninstallStartedAt = null;
      next.uninstalledAt = null;
    } else if (to === "disabled") {
      next.disabledAt = at;
    } else if (to === "uninstalling") {
      next.uninstallStartedAt = at;
    } else {
      next.uninstalledAt = at;
    }
    return save(scope, next, before.status, reason, at);
  }

  return {
    /** The PHP status(): a company with no row is enabled. */
    async status(companyId: string): Promise<LifecycleStatus> {
      return (await current(companyId)).status;
    },

    /** The PHP isEnabled(): only the enabled status can serve. */
    async isEnabled(companyId: string): Promise<boolean> {
      return (await current(companyId)).status === "enabled";
    },

    /** Called at startup. Creates the row when missing, reinstalls an uninstalled company, and records a new version. */
    async ensureInstalled(companyId: string, version: string): Promise<LifecycleState> {
      const scope = requireCompanyId(companyId);
      const existing = await deps.states.get(scope);
      if (!existing) {
        const at = now();
        const created: LifecycleState = { ...implicitState(scope), installedVersion: version, enabledAt: at };
        return save(scope, created, null, null, at);
      }
      if (existing.status === "uninstalled") return move(scope, "enabled", { version, reason: "Extension reinstalled." });
      if (existing.installedVersion === version) return existing;
      const at = now();
      return save(scope, { ...existing, installedVersion: version }, existing.status, existing.reason, at);
    },

    enable(companyId: string, version: string, reason: string | null = null): Promise<LifecycleState> {
      return move(companyId, "enabled", { version, reason });
    },

    disable(companyId: string, reason: string | null = null): Promise<LifecycleState> {
      return move(companyId, "disabled", { reason });
    },

    beginUninstall(companyId: string, reason: string | null = null): Promise<LifecycleState> {
      return move(companyId, "uninstalling", { reason });
    },

    completeUninstall(companyId: string): Promise<LifecycleState> {
      return move(companyId, "uninstalled", { reason: null });
    },
  };
}

export type CommerceLifecycle = ReturnType<typeof createCommerceLifecycle>;
