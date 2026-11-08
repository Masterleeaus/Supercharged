/**
 * Drizzle implementation of the workflow, action and outbox stores. Pass a database or a transaction handle.
 * Every query filters on company_id. Lock-sensitive paths use SELECT ... FOR UPDATE (with SKIP LOCKED for
 * claims) or a conditional upsert, so two workers cannot both take the same run, step, action or event.
 *
 * Query builders are exported so tests can render the SQL with PgDialect and check the tenant filter.
 */
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { chatbotConversations } from "../../../../shared/schema.ts";
import {
  chatbotEventOutbox,
  chatbotStructuredActions,
  chatbotWebhookDeliveries,
  chatbotWebhookSubscriptions,
  chatbotWorkflowRuns,
  chatbotWorkflowSteps,
} from "../db/events.ts";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventsExecutor = PgDatabase<any, any, any>;
export type EventsDrizzleStore = WorkflowStore & ActionStore & OutboxStore;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type RunRow = typeof chatbotWorkflowRuns.$inferSelect;
type ActionRow = typeof chatbotStructuredActions.$inferSelect;
type OutboxRow = typeof chatbotEventOutbox.$inferSelect;

function runFromRow(row: RunRow): WorkflowRunRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    workflow: row.workflow,
    status: row.status as WorkflowRunRecord["status"],
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    context: (row.context ?? {}) as Record<string, unknown>,
    output: (row.output ?? null) as Record<string, unknown> | null,
    error: row.error,
    nextRunAt: row.nextRunAt,
    conversationId: row.conversationId,
    idempotencyKey: row.idempotencyKey,
    lockedAt: row.lockedAt,
    lockToken: row.lockToken,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runToRow(run: WorkflowRunRecord) {
  return {
    companyId: run.companyId,
    id: run.id,
    workflow: run.workflow,
    conversationId: run.conversationId,
    idempotencyKey: run.idempotencyKey,
    status: run.status,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    context: run.context,
    output: run.output,
    error: run.error,
    nextRunAt: run.nextRunAt,
    lockedAt: run.lockedAt,
    lockToken: run.lockToken,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function actionFromRow(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    conversationId: row.conversationId,
    kind: row.kind as ActionRecord["kind"],
    args: row.args as Record<string, unknown>,
    status: row.status as ActionRecord["status"],
    requiresApproval: row.requiresApproval,
    approvedBy: row.approvedBy,
    resultRef: row.resultRef,
    failureReason: row.failureReason,
    expiresAt: row.expiresAt,
    idempotencyKey: row.idempotencyKey,
    presentation: (row.presentation ?? null) as ActionRecord["presentation"],
    executionToken: row.executionToken,
    executionStartedAt: row.executionStartedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function actionToRow(action: ActionRecord) {
  return {
    companyId: action.companyId,
    id: action.id,
    conversationId: action.conversationId,
    kind: action.kind,
    args: action.args,
    presentation: action.presentation,
    status: action.status,
    requiresApproval: action.requiresApproval,
    approvedBy: action.approvedBy,
    resultRef: action.resultRef,
    failureReason: action.failureReason,
    expiresAt: action.expiresAt,
    idempotencyKey: action.idempotencyKey,
    executionToken: action.executionToken,
    executionStartedAt: action.executionStartedAt,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function outboxFromRow(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    topic: row.topic,
    aggregateId: row.aggregateId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    dedupeKey: row.dedupeKey,
    status: row.status as OutboxRecord["status"],
    attempts: row.attempts,
    availableAt: row.availableAt,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    lockedAt: row.lockedAt,
    lockedBy: row.lockedBy,
    realtimePublishedAt: row.realtimePublishedAt,
    lastError: row.lastError,
    failedAt: row.failedAt,
  };
}

// ---------------------------------------------------------------------------
// Query builders (exported for tests)
// ---------------------------------------------------------------------------

export function workflowRunByIdQuery(db: EventsExecutor, companyId: string, runId: string) {
  return db
    .select()
    .from(chatbotWorkflowRuns)
    .where(and(eq(chatbotWorkflowRuns.companyId, companyId), eq(chatbotWorkflowRuns.id, runId)));
}

export function workflowRunByIdempotencyQuery(db: EventsExecutor, companyId: string, workflow: string, key: string) {
  return db
    .select()
    .from(chatbotWorkflowRuns)
    .where(
      and(
        eq(chatbotWorkflowRuns.companyId, companyId),
        eq(chatbotWorkflowRuns.workflow, workflow),
        eq(chatbotWorkflowRuns.idempotencyKey, key),
      ),
    )
    .limit(1);
}

export function outboxClaimQuery(db: EventsExecutor, companyId: string, limit: number, now: Date, leaseSeconds: number) {
  const leaseExpired = new Date(now.getTime() - leaseSeconds * 1000);
  return db
    .select()
    .from(chatbotEventOutbox)
    .where(
      and(
        eq(chatbotEventOutbox.companyId, companyId),
        eq(chatbotEventOutbox.status, "pending"),
        lte(chatbotEventOutbox.availableAt, now),
        or(isNull(chatbotEventOutbox.lockedAt), lte(chatbotEventOutbox.lockedAt, leaseExpired)),
      ),
    )
    .orderBy(asc(chatbotEventOutbox.createdAt), asc(chatbotEventOutbox.id))
    .limit(limit)
    .for("update", { skipLocked: true });
}

export function outboxDeadLetterQuery(db: EventsExecutor, companyId: string, limit: number) {
  return db
    .select()
    .from(chatbotEventOutbox)
    .where(and(eq(chatbotEventOutbox.companyId, companyId), eq(chatbotEventOutbox.status, "failed")))
    .orderBy(desc(chatbotEventOutbox.failedAt), desc(chatbotEventOutbox.id))
    .limit(limit);
}

export function actionListQuery(db: EventsExecutor, companyId: string, conversationId: string, status?: ActionRecord["status"]) {
  const filters = [eq(chatbotStructuredActions.companyId, companyId), eq(chatbotStructuredActions.conversationId, conversationId)];
  if (status) filters.push(eq(chatbotStructuredActions.status, status));
  return db
    .select()
    .from(chatbotStructuredActions)
    .where(and(...filters))
    .orderBy(desc(chatbotStructuredActions.createdAt));
}

export function expireProposedQuery(db: EventsExecutor, companyId: string, cutoff: Date, now: Date) {
  return db
    .update(chatbotStructuredActions)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(chatbotStructuredActions.companyId, companyId),
        eq(chatbotStructuredActions.status, "proposed"),
        lt(chatbotStructuredActions.createdAt, cutoff),
      ),
    )
    .returning({ id: chatbotStructuredActions.id });
}

export function webhookSubscriptionsQuery(db: EventsExecutor, companyId: string) {
  return db.select().from(chatbotWebhookSubscriptions).where(eq(chatbotWebhookSubscriptions.companyId, companyId));
}

export function webhookDeliveriesQuery(db: EventsExecutor, companyId: string, eventId: string) {
  return db
    .select()
    .from(chatbotWebhookDeliveries)
    .where(and(eq(chatbotWebhookDeliveries.companyId, companyId), eq(chatbotWebhookDeliveries.eventId, eventId)));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createDrizzleEventsStore(db: EventsExecutor): EventsDrizzleStore {
  const pk = (companyId: string, id: string) => and(eq(chatbotEventOutbox.companyId, companyId), eq(chatbotEventOutbox.id, id));
  const leaseFence = (leaseOwner: string | undefined) =>
    leaseOwner === undefined ? undefined : eq(chatbotEventOutbox.lockedBy, leaseOwner);

  return {
    // ---- workflows -------------------------------------------------------
    async findRunByIdempotencyKey(companyId, workflow, key) {
      const [row] = await workflowRunByIdempotencyQuery(db, companyId, workflow, key);
      return row ? runFromRow(row) : null;
    },

    async insertRun(companyId, run) {
      const rows = await db
        .insert(chatbotWorkflowRuns)
        .values(runToRow({ ...run, companyId }))
        .onConflictDoNothing({
          target: [chatbotWorkflowRuns.companyId, chatbotWorkflowRuns.workflow, chatbotWorkflowRuns.idempotencyKey],
          where: sql`${chatbotWorkflowRuns.idempotencyKey} IS NOT NULL`,
        })
        .returning();
      return rows[0] ? runFromRow(rows[0]) : null;
    },

    async getRun(companyId, runId) {
      const [row] = await workflowRunByIdQuery(db, companyId, runId);
      return row ? runFromRow(row) : null;
    },

    async mutateRun(companyId, runId, mutate) {
      return db.transaction(async (tx) => {
        const [row] = await workflowRunByIdQuery(tx, companyId, runId).for("update");
        if (!row) return null;
        const current = runFromRow(row);
        const patch = mutate(current);
        if (!patch) return current;
        const next = { ...current, ...patch };
        await tx
          .update(chatbotWorkflowRuns)
          .set(runToRow(next))
          .where(and(eq(chatbotWorkflowRuns.companyId, companyId), eq(chatbotWorkflowRuns.id, runId)));
        return next;
      });
    },

    async claimRun(companyId, now, staleAfterSeconds, lockToken): Promise<WorkflowRunRecord | null> {
      const staleBefore = new Date(now.getTime() - staleAfterSeconds * 1000);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(chatbotWorkflowRuns)
          .where(
            and(
              eq(chatbotWorkflowRuns.companyId, companyId),
              or(
                and(
                  eq(chatbotWorkflowRuns.status, "queued"),
                  or(isNull(chatbotWorkflowRuns.nextRunAt), lte(chatbotWorkflowRuns.nextRunAt, now)),
                ),
                and(eq(chatbotWorkflowRuns.status, "running"), lte(chatbotWorkflowRuns.lockedAt, staleBefore)),
              ),
            ),
          )
          .orderBy(asc(chatbotWorkflowRuns.nextRunAt), asc(chatbotWorkflowRuns.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!row) return null;
        const current = runFromRow(row);
        const claimed = { ...current, status: "running" as const, startedAt: current.startedAt ?? now, lockedAt: now, lockToken, updatedAt: now };
        await tx
          .update(chatbotWorkflowRuns)
          .set(runToRow(claimed))
          .where(and(eq(chatbotWorkflowRuns.companyId, companyId), eq(chatbotWorkflowRuns.id, current.id)));
        return claimed;
      });
    },

    async claimStep(companyId, runId, stepKey, lockToken, now, staleAfterSeconds): Promise<StepClaim> {
      const staleBefore = new Date(now.getTime() - staleAfterSeconds * 1000);
      // Takes the step only when no row exists, or the row is a stale running lease. A completed row is never overwritten.
      const claimedRows = await db
        .insert(chatbotWorkflowSteps)
        .values({ companyId, runId, stepKey, status: "running", lockToken, lockedAt: now, output: null })
        .onConflictDoUpdate({
          target: [chatbotWorkflowSteps.companyId, chatbotWorkflowSteps.runId, chatbotWorkflowSteps.stepKey],
          set: { lockToken, lockedAt: now, status: "running", output: null, updatedAt: now },
          setWhere: and(eq(chatbotWorkflowSteps.status, "running"), lte(chatbotWorkflowSteps.lockedAt, staleBefore)),
        })
        .returning({ id: chatbotWorkflowSteps.stepKey });
      if (claimedRows.length > 0) return { state: "claimed" };

      const [existing] = await db
        .select()
        .from(chatbotWorkflowSteps)
        .where(
          and(
            eq(chatbotWorkflowSteps.companyId, companyId),
            eq(chatbotWorkflowSteps.runId, runId),
            eq(chatbotWorkflowSteps.stepKey, stepKey),
          ),
        )
        .limit(1);
      if (existing?.status === "completed") return { state: "done", output: (existing.output ?? {}) as Record<string, unknown> };
      return { state: "busy" };
    },

    async completeStep(companyId, runId, stepKey, lockToken, output, now) {
      const rows = await db
        .update(chatbotWorkflowSteps)
        .set({ status: "completed", output, lockedAt: now, updatedAt: now })
        .where(
          and(
            eq(chatbotWorkflowSteps.companyId, companyId),
            eq(chatbotWorkflowSteps.runId, runId),
            eq(chatbotWorkflowSteps.stepKey, stepKey),
            eq(chatbotWorkflowSteps.lockToken, lockToken),
            eq(chatbotWorkflowSteps.status, "running"),
          ),
        )
        .returning({ key: chatbotWorkflowSteps.stepKey });
      return rows.length > 0;
    },

    async releaseStep(companyId, runId, stepKey, lockToken) {
      const rows = await db
        .delete(chatbotWorkflowSteps)
        .where(
          and(
            eq(chatbotWorkflowSteps.companyId, companyId),
            eq(chatbotWorkflowSteps.runId, runId),
            eq(chatbotWorkflowSteps.stepKey, stepKey),
            eq(chatbotWorkflowSteps.lockToken, lockToken),
            eq(chatbotWorkflowSteps.status, "running"),
          ),
        )
        .returning({ key: chatbotWorkflowSteps.stepKey });
      return rows.length > 0;
    },

    // ---- actions ---------------------------------------------------------
    async conversationExists(companyId, conversationId) {
      const rows = await db
        .select({ id: chatbotConversations.id })
        .from(chatbotConversations)
        .where(and(eq(chatbotConversations.companyId, companyId), eq(chatbotConversations.id, conversationId)))
        .limit(1);
      return rows.length > 0;
    },

    async findByIdempotencyKey(companyId, conversationId, key) {
      const [row] = await db
        .select()
        .from(chatbotStructuredActions)
        .where(
          and(
            eq(chatbotStructuredActions.companyId, companyId),
            eq(chatbotStructuredActions.conversationId, conversationId),
            eq(chatbotStructuredActions.idempotencyKey, key),
          ),
        )
        .limit(1);
      return row ? actionFromRow(row) : null;
    },

    async insertAction(companyId, action) {
      const rows = await db
        .insert(chatbotStructuredActions)
        .values(actionToRow({ ...action, companyId }))
        .onConflictDoNothing({
          target: [chatbotStructuredActions.companyId, chatbotStructuredActions.conversationId, chatbotStructuredActions.idempotencyKey],
          where: sql`${chatbotStructuredActions.idempotencyKey} IS NOT NULL`,
        })
        .returning();
      return rows[0] ? actionFromRow(rows[0]) : null;
    },

    async getAction(companyId, actionId) {
      const [row] = await db
        .select()
        .from(chatbotStructuredActions)
        .where(and(eq(chatbotStructuredActions.companyId, companyId), eq(chatbotStructuredActions.id, actionId)))
        .limit(1);
      return row ? actionFromRow(row) : null;
    },

    async listActions(companyId, conversationId, status) {
      const rows = await actionListQuery(db, companyId, conversationId, status);
      return rows.map(actionFromRow);
    },

    async mutateAction(companyId, actionId, mutate) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(chatbotStructuredActions)
          .where(and(eq(chatbotStructuredActions.companyId, companyId), eq(chatbotStructuredActions.id, actionId)))
          .for("update");
        if (!row) return null;
        const current = actionFromRow(row);
        const patch = mutate(current);
        if (!patch) return null;
        const next = { ...current, ...patch };
        await tx
          .update(chatbotStructuredActions)
          .set(actionToRow(next))
          .where(and(eq(chatbotStructuredActions.companyId, companyId), eq(chatbotStructuredActions.id, actionId)));
        return next;
      });
    },

    async expireProposedBefore(companyId, cutoff, now) {
      const rows = await expireProposedQuery(db, companyId, cutoff, now);
      return rows.length;
    },

    // ---- outbox and webhooks ---------------------------------------------
    async appendEvent(companyId, event) {
      const rows = await db
        .insert(chatbotEventOutbox)
        .values({
          companyId,
          id: event.id,
          topic: event.topic,
          aggregateId: event.aggregateId,
          payload: event.payload,
          dedupeKey: event.dedupeKey,
          status: event.status,
          attempts: event.attempts,
          availableAt: event.availableAt,
          publishedAt: event.publishedAt,
          createdAt: event.createdAt,
          lockedAt: event.lockedAt,
          lockedBy: event.lockedBy,
          realtimePublishedAt: event.realtimePublishedAt,
          lastError: event.lastError,
        })
        .onConflictDoNothing({ target: [chatbotEventOutbox.companyId, chatbotEventOutbox.dedupeKey] })
        .returning();
      if (rows[0]) return outboxFromRow(rows[0]);
      const [existing] = await db
        .select()
        .from(chatbotEventOutbox)
        .where(and(eq(chatbotEventOutbox.companyId, companyId), eq(chatbotEventOutbox.dedupeKey, event.dedupeKey)))
        .limit(1);
      return outboxFromRow(existing);
    },

    async claimBatch(companyId, limit, now, lease) {
      return db.transaction(async (tx) => {
        const rows = await outboxClaimQuery(tx, companyId, limit, now, lease.leaseSeconds);
        if (rows.length === 0) return [];
        const ids = rows.map((r) => r.id);
        await tx
          .update(chatbotEventOutbox)
          .set({ lockedAt: now, lockedBy: lease.workerId })
          .where(and(eq(chatbotEventOutbox.companyId, companyId), inArray(chatbotEventOutbox.id, ids)));
        return rows.map((r) => outboxFromRow({ ...r, lockedAt: now, lockedBy: lease.workerId }));
      });
    },

    async markRealtimePublished(companyId, eventId, at, leaseOwner) {
      const rows = await db
        .update(chatbotEventOutbox)
        .set({ realtimePublishedAt: sql`coalesce(${chatbotEventOutbox.realtimePublishedAt}, ${at})` })
        .where(and(pk(companyId, eventId), leaseFence(leaseOwner)))
        .returning({ id: chatbotEventOutbox.id });
      return rows.length > 0;
    },

    async markPublished(companyId, eventId, at, leaseOwner) {
      const rows = await db
        .update(chatbotEventOutbox)
        .set({ status: "published", publishedAt: at, lockedAt: null, lockedBy: null, lastError: null })
        .where(and(pk(companyId, eventId), leaseFence(leaseOwner)))
        .returning({ id: chatbotEventOutbox.id });
      return rows.length > 0;
    },

    async markFailed(companyId, eventId, update) {
      const rows = await db
        .update(chatbotEventOutbox)
        .set({
          attempts: update.attempts ?? sql`${chatbotEventOutbox.attempts} + 1`,
          availableAt: update.nextAvailableAt,
          lockedAt: null,
          lockedBy: null,
          lastError: update.lastError,
        })
        .where(and(pk(companyId, eventId), leaseFence(update.leaseOwner)))
        .returning({ id: chatbotEventOutbox.id });
      return rows.length > 0;
    },

    async markDeadLetter(companyId, eventId, update) {
      const rows = await db
        .update(chatbotEventOutbox)
        .set({
          status: "failed",
          attempts: update.attempts ?? sql`${chatbotEventOutbox.attempts} + 1`,
          failedAt: update.failedAt,
          lockedAt: null,
          lockedBy: null,
          lastError: update.lastError,
        })
        .where(and(pk(companyId, eventId), leaseFence(update.leaseOwner)))
        .returning({ id: chatbotEventOutbox.id });
      return rows.length > 0;
    },

    async listDeadLetters(companyId, limit) {
      const rows = await outboxDeadLetterQuery(db, companyId, limit);
      return rows.map(outboxFromRow);
    },

    async insertSubscription(companyId, subscription: WebhookSubscription) {
      await db.insert(chatbotWebhookSubscriptions).values({
        companyId,
        id: subscription.id,
        url: subscription.url,
        topics: subscription.topics,
        active: subscription.active,
        signingSecret: subscription.signingSecret,
      });
    },

    async listSubscriptions(companyId) {
      const rows = await webhookSubscriptionsQuery(db, companyId);
      return rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        url: r.url,
        topics: r.topics as string[],
        active: r.active,
        signingSecret: r.signingSecret as WebhookSubscription["signingSecret"],
      }));
    },

    async listDeliveries(companyId, eventId) {
      const rows = await webhookDeliveriesQuery(db, companyId, eventId);
      return rows.map((r) => ({
        companyId: r.companyId,
        eventId: r.eventId,
        subscriptionId: r.subscriptionId,
        httpStatus: r.httpStatus,
        ok: r.ok,
        attempt: r.attempt,
        errorMessage: r.errorMessage,
        deliveredAt: r.deliveredAt,
      }) as WebhookDeliveryRecord);
    },

    async recordDelivery(companyId, delivery) {
      await db.insert(chatbotWebhookDeliveries).values({
        companyId,
        eventId: delivery.eventId,
        subscriptionId: delivery.subscriptionId,
        attempt: delivery.attempt,
        httpStatus: delivery.httpStatus,
        ok: delivery.ok,
        errorMessage: delivery.errorMessage,
        deliveredAt: delivery.deliveredAt,
      });
    },
  };
}
