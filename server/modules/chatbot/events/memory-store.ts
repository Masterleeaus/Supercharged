/**
 * In-memory implementation of the workflow, action and outbox stores. Used by the tests and by local runs.
 * Every read and write is keyed by companyId first, so another company's row is never returned.
 * mutate* methods compute the patch before writing, so a refused transition leaves the row unchanged.
 */
import type { WebhookSubscription } from "../contracts/index.ts";
import type {
  ActionRecord,
  ActionStore,
  OutboxRecord,
  OutboxStore,
  StepClaim,
  WebhookDeliveryRecord,
  WorkflowRunRecord,
  WorkflowStore,
} from "./types.ts";

type Scoped<T> = Map<string, Map<string, T>>;

function scope<T>(map: Scoped<T>, companyId: string): Map<string, T> {
  let inner = map.get(companyId);
  if (!inner) {
    inner = new Map();
    map.set(companyId, inner);
  }
  return inner;
}

/** Returns the row only when the write is not fenced out: no owner given, or the owner still holds the lease. */
function fenced<T extends { lockedBy: string | null }>(row: T | undefined, leaseOwner: string | undefined): T | undefined {
  if (!row) return undefined;
  if (leaseOwner !== undefined && row.lockedBy !== leaseOwner) return undefined;
  return row;
}

interface StepRow {
  status: "running" | "completed";
  lockToken: string;
  lockedAt: Date;
  output: Record<string, unknown> | null;
}

export interface MemoryEventsStore extends WorkflowStore, ActionStore, OutboxStore {
  /** Test helper: marks a conversation as belonging to a company. */
  addConversation(companyId: string, conversationId: string): void;
}

export function createMemoryEventsStore(): MemoryEventsStore {
  const runs: Scoped<WorkflowRunRecord> = new Map();
  const steps: Map<string, Map<string, StepRow>> = new Map();
  const actions: Scoped<ActionRecord> = new Map();
  const conversations: Map<string, Set<string>> = new Map();
  const outbox: Scoped<OutboxRecord> = new Map();
  const subscriptions: Scoped<WebhookSubscription> = new Map();
  const deliveries: Map<string, WebhookDeliveryRecord[]> = new Map();

  const stepKey = (companyId: string, runId: string, key: string) => `${companyId}\u0000${runId}\u0000${key}`;

  const store: MemoryEventsStore = {
    addConversation(companyId, conversationId) {
      let set = conversations.get(companyId);
      if (!set) {
        set = new Set();
        conversations.set(companyId, set);
      }
      set.add(conversationId);
    },

    // ---- workflows -------------------------------------------------------
    async findRunByIdempotencyKey(companyId, workflow, key) {
      for (const run of scope(runs, companyId).values()) {
        if (run.workflow === workflow && run.idempotencyKey === key) return { ...run };
      }
      return null;
    },
    async insertRun(companyId, run) {
      if (run.idempotencyKey && (await store.findRunByIdempotencyKey(companyId, run.workflow, run.idempotencyKey))) {
        return null;
      }
      scope(runs, companyId).set(run.id, { ...run });
      return { ...run };
    },
    async getRun(companyId, runId) {
      const run = scope(runs, companyId).get(runId);
      return run ? { ...run } : null;
    },
    async mutateRun(companyId, runId, mutate) {
      const table = scope(runs, companyId);
      const current = table.get(runId);
      if (!current) return null;
      const patch = mutate({ ...current });
      if (!patch) return { ...current };
      const next = { ...current, ...patch };
      table.set(runId, next);
      return { ...next };
    },
    async claimRun(companyId, now, staleAfterSeconds, lockToken) {
      const staleBefore = now.getTime() - staleAfterSeconds * 1000;
      const candidates = [...scope(runs, companyId).values()]
        .filter((r) =>
          (r.status === "queued" && (r.nextRunAt === null || r.nextRunAt.getTime() <= now.getTime())) ||
          (r.status === "running" && r.lockedAt !== null && r.lockedAt.getTime() <= staleBefore),
        )
        .sort((a, b) => (a.nextRunAt?.getTime() ?? 0) - (b.nextRunAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
      const next = candidates[0];
      if (!next) return null;
      const claimed: WorkflowRunRecord = {
        ...next,
        status: "running",
        startedAt: next.startedAt ?? now,
        lockedAt: now,
        lockToken,
        updatedAt: now,
      };
      scope(runs, companyId).set(next.id, claimed);
      return { ...claimed };
    },
    async claimStep(companyId, runId, key, lockToken, now, staleAfterSeconds): Promise<StepClaim> {
      const id = stepKey(companyId, runId, key);
      const current = steps.get(companyId)?.get(id);
      if (current?.status === "completed") return { state: "done", output: current.output ?? {} };
      if (current && current.lockedAt.getTime() > now.getTime() - staleAfterSeconds * 1000) return { state: "busy" };
      let table = steps.get(companyId);
      if (!table) {
        table = new Map();
        steps.set(companyId, table);
      }
      table.set(id, { status: "running", lockToken, lockedAt: now, output: null });
      return { state: "claimed" };
    },
    async completeStep(companyId, runId, key, lockToken, output, now) {
      const id = stepKey(companyId, runId, key);
      const current = steps.get(companyId)?.get(id);
      if (!current || current.lockToken !== lockToken || current.status !== "running") return false;
      steps.get(companyId)!.set(id, { status: "completed", lockToken, lockedAt: now, output: { ...output } });
      return true;
    },
    async releaseStep(companyId, runId, key, lockToken) {
      const id = stepKey(companyId, runId, key);
      const current = steps.get(companyId)?.get(id);
      if (!current || current.lockToken !== lockToken || current.status !== "running") return false;
      steps.get(companyId)!.delete(id);
      return true;
    },

    // ---- actions ---------------------------------------------------------
    async conversationExists(companyId, conversationId) {
      return conversations.get(companyId)?.has(conversationId) ?? false;
    },
    async findByIdempotencyKey(companyId, conversationId, key) {
      for (const action of scope(actions, companyId).values()) {
        if (action.conversationId === conversationId && action.idempotencyKey === key) return { ...action };
      }
      return null;
    },
    async insertAction(companyId, action) {
      if (action.idempotencyKey && (await store.findByIdempotencyKey(companyId, action.conversationId, action.idempotencyKey))) {
        return null;
      }
      scope(actions, companyId).set(action.id, { ...action });
      return { ...action };
    },
    async getAction(companyId, actionId) {
      const action = scope(actions, companyId).get(actionId);
      return action ? { ...action } : null;
    },
    async listActions(companyId, conversationId, status) {
      return [...scope(actions, companyId).values()]
        .filter((a) => a.conversationId === conversationId && (status === undefined || a.status === status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((a) => ({ ...a }));
    },
    async mutateAction(companyId, actionId, mutate) {
      const table = scope(actions, companyId);
      const current = table.get(actionId);
      if (!current) return null;
      const patch = mutate({ ...current });
      if (!patch) return null;
      const next = { ...current, ...patch };
      table.set(actionId, next);
      return { ...next };
    },
    async expireProposedBefore(companyId, cutoff, now) {
      const table = scope(actions, companyId);
      let count = 0;
      for (const [id, action] of table) {
        if (action.status === "proposed" && action.createdAt.getTime() < cutoff.getTime()) {
          table.set(id, { ...action, status: "expired", updatedAt: now });
          count += 1;
        }
      }
      return count;
    },

    // ---- outbox and webhooks ---------------------------------------------
    async appendEvent(companyId, event) {
      const table = scope(outbox, companyId);
      for (const existing of table.values()) {
        if (existing.dedupeKey === event.dedupeKey) return { ...existing };
      }
      table.set(event.id, { ...event });
      return { ...event };
    },
    async claimBatch(companyId, limit, now, lease) {
      const table = scope(outbox, companyId);
      const leaseExpired = now.getTime() - lease.leaseSeconds * 1000;
      const due = [...table.values()]
        .filter((e) =>
          e.status === "pending" &&
          e.availableAt.getTime() <= now.getTime() &&
          (e.lockedAt === null || e.lockedAt.getTime() <= leaseExpired),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .slice(0, limit);
      return due.map((e) => {
        const leased = { ...e, lockedAt: now, lockedBy: lease.workerId };
        table.set(e.id, leased);
        return { ...leased };
      });
    },
    async markRealtimePublished(companyId, eventId, at, leaseOwner) {
      const row = fenced(scope(outbox, companyId).get(eventId), leaseOwner);
      if (!row) return false;
      if (row.realtimePublishedAt === null) row.realtimePublishedAt = at;
      return true;
    },
    async markPublished(companyId, eventId, at, leaseOwner) {
      const row = fenced(scope(outbox, companyId).get(eventId), leaseOwner);
      if (!row) return false;
      Object.assign(row, { status: "published", publishedAt: at, lockedAt: null, lockedBy: null, lastError: null });
      return true;
    },
    async markFailed(companyId, eventId, update) {
      const row = fenced(scope(outbox, companyId).get(eventId), update.leaseOwner);
      if (!row) return false;
      Object.assign(row, {
        attempts: update.attempts ?? row.attempts + 1,
        availableAt: update.nextAvailableAt,
        lockedAt: null,
        lockedBy: null,
        lastError: update.lastError,
      });
      return true;
    },
    async markDeadLetter(companyId, eventId, update) {
      const row = fenced(scope(outbox, companyId).get(eventId), update.leaseOwner);
      if (!row) return false;
      Object.assign(row, {
        status: "failed",
        attempts: update.attempts ?? row.attempts + 1,
        failedAt: update.failedAt,
        lockedAt: null,
        lockedBy: null,
        lastError: update.lastError,
      });
      return true;
    },
    async listDeadLetters(companyId, limit) {
      return [...scope(outbox, companyId).values()]
        .filter((e) => e.status === "failed")
        .sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0) || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map((e) => ({ ...e }));
    },
    async insertSubscription(companyId, subscription) {
      scope(subscriptions, companyId).set(subscription.id, { ...subscription });
    },
    async listSubscriptions(companyId) {
      return [...scope(subscriptions, companyId).values()].map((s) => ({ ...s }));
    },
    async listDeliveries(companyId, eventId) {
      return (deliveries.get(companyId) ?? []).filter((d) => d.eventId === eventId).map((d) => ({ ...d }));
    },
    async recordDelivery(companyId, delivery) {
      const list = deliveries.get(companyId) ?? [];
      list.push({ ...delivery });
      deliveries.set(companyId, list);
    },
  };
  return store;
}
