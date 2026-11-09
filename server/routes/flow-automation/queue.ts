/** Test-call queue status and cancel routes. */
import { Router, Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { flowTestQueue, phoneNumbers, calls, agents, incomingConnections } from "@shared/schema";
import { eq, and, or, sql, inArray, isNull } from "drizzle-orm";
import { logger } from "../../utils/logger";
import { companyForRead } from "./shared";
import { placeFlowTestCall } from "./flow-test-call";

export function registerFlowQueueRoutes(router: Router): void {
  // ── Queue status endpoint ────────────────────────────────────────────────────
  // Polls the status of a queued test-call entry. Lifecycle:
  //   waiting → (atomic claim here) → processing (placeFlowTestCall fired) → completed | failed
  //   waiting → (15 min timeout) → failed
  //
  // When position is 1 and a free pool number exists, this endpoint:
  //   1. Atomically moves the entry to 'processing'
  //   2. Fires placeFlowTestCall as a background job (setImmediate, no req/res)
  //   3. Returns { status:'processing', ready:false } immediately
  // placeFlowTestCall calls completeQueue/failQueue which update the DB entry.
  // The frontend polls until it sees 'completed' (with callId) or 'failed'.
  router.get("/queue/:entryId", async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const companyId = companyForRead(req, res);
      if (!companyId) return;

      const { entryId } = req.params;

      const [entry] = await db
        .select()
        .from(flowTestQueue)
        .where(and(eq(flowTestQueue.id, entryId), eq(flowTestQueue.userId, userId), eq(flowTestQueue.companyId, companyId)));

      if (!entry) return res.status(404).json({ error: "Queue entry not found" });

      // ── Terminal statuses: return immediately ──────────────────────────────
      if (entry.status === 'completed') {
        return res.json({ status: 'completed', position: 0, ready: false, callId: entry.callId });
      }
      if (entry.status === 'failed') {
        return res.json({ status: 'failed', position: 0, ready: false, errorMessage: entry.errorMessage });
      }
      if (entry.status === 'cancelled') {
        return res.json({ status: 'cancelled', position: 0, ready: false, message: entry.errorMessage || 'Queue entry was cancelled.' });
      }

      // ── Processing: already claimed, re-submit is in flight ────────────────
      if (entry.status === 'processing') {
        // Auto-fail if processing for > 3 minutes (re-submit never came or hung)
        const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000);
        if (entry.processedAt && entry.processedAt < threeMinAgo) {
          await db.update(flowTestQueue)
            .set({ status: 'failed', errorMessage: 'Call placement timed out. Please try again.' })
            .where(eq(flowTestQueue.id, entryId));
          return res.json({ status: 'failed', position: 0, ready: false, errorMessage: 'Call placement timed out. Please try again.' });
        }
        // Normal processing — re-submit is in-flight, keep polling
        return res.json({ status: 'processing', position: 0, ready: false });
      }

      // ── Waiting: check position and availability ────────────────────────────

      // GLOBAL proactive stale cleanup: expire ALL waiting entries older than 15 minutes.
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
      await db.update(flowTestQueue)
        .set({ status: 'failed', errorMessage: 'Queue timeout: abandoned (15 minutes).' })
        .where(and(
          eq(flowTestQueue.status, 'waiting'),
          eq(flowTestQueue.companyId, companyId),
          sql`${flowTestQueue.createdAt} < ${fifteenMinsAgo}`
        ));

      if (entry.createdAt < fifteenMinsAgo) {
        return res.json({
          status: 'failed', position: 0, ready: false,
          errorMessage: 'Queue timeout exceeded (15 minutes). Please try again.',
        });
      }

      // Calculate position (entries created before this one that are still waiting), +1
      // Position is accurate because stale entries were cleaned up above.
      const [{ count: ahead }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(flowTestQueue)
        .where(and(
          eq(flowTestQueue.status, 'waiting'),
          eq(flowTestQueue.companyId, companyId),
          sql`${flowTestQueue.createdAt} < ${entry.createdAt}`
        ));
      const position = (ahead ?? 0) + 1;

      if (position > 1) {
        // Not at front of queue yet
        return res.json({ status: 'waiting', position, ready: false });
      }

      // ── Position 1: check if a pool phone is free ──────────────────────────
      // Exclude phones connected to incoming agents (same filter the test endpoint applies)
      const connectedPhoneIds = await db
        .select({ id: incomingConnections.phoneNumberId })
        .from(incomingConnections)
        .where(eq(incomingConnections.companyId, companyId));
      const connectedIdSet = new Set(connectedPhoneIds.map(ic => ic.id).filter(Boolean));

      const poolPhones = await db
        .select()
        .from(phoneNumbers)
        .where(and(
          and(eq(phoneNumbers.isSystemPool, true), or(isNull(phoneNumbers.companyId), eq(phoneNumbers.companyId, companyId))),
          eq(phoneNumbers.status, 'available'),
          isNull(phoneNumbers.userId)
        ));
      const availablePoolPhones = poolPhones.filter(p => !connectedIdSet.has(p.id));

      const activeCallRows = await db
        .select({ fromNumber: calls.fromNumber })
        .from(calls)
        .where(and(inArray(calls.status, ['pending', 'initiated', 'ringing', 'in-progress']), eq(calls.companyId, companyId)));
      const busySet = new Set(activeCallRows.map(r => r.fromNumber).filter(Boolean));
      const freePhones = availablePoolPhones.filter(p => !busySet.has(p.phoneNumber));

      if (freePhones.length === 0) {
        // Still waiting at position 1 but no free phone yet
        return res.json({ status: 'waiting', position: 1, ready: false });
      }

      // ── Atomically claim the entry (waiting → processing) ─────────────────
      const [claimed] = await db
        .update(flowTestQueue)
        .set({ status: 'processing', processedAt: new Date() })
        .where(and(eq(flowTestQueue.id, entryId), eq(flowTestQueue.status, 'waiting')))
        .returning();

      if (!claimed) {
        // Another concurrent poll already claimed it — return processing (in-flight)
        return res.json({ status: 'processing', position: 0, ready: false });
      }

      // ── Server-side call placement: fire & forget ──────────────────────────
      logger.info(`⚡ [Queue] Entry ${entryId} claimed → triggering server-side call placement.`);

      setImmediate(() =>
        placeFlowTestCall({
          userId: claimed.userId,
          companyId,
          flowId: claimed.flowId,
          toPhone: claimed.toPhone,
          queueEntryId: claimed.id,
        }).catch((err: any) => {
          logger.error(`[Queue] Background test call error for ${claimed.id}:`, err);
          db.update(flowTestQueue)
            .set({ status: 'failed', errorMessage: err?.message || 'Unexpected error during call placement' })
            .where(and(eq(flowTestQueue.id, claimed.id), eq(flowTestQueue.status, 'processing')))
            .then(() => { }).catch(() => { });
        })
      );

      return res.json({ status: 'processing', position: 0, ready: false });

    } catch (error: any) {
      logger.error("Error fetching queue status:", error);
      return res.status(500).json({ error: "Failed to fetch queue status" });
    }
  });

  // ── Cancel queue entry ───────────────────────────────────────────────────────
  router.delete("/queue/:entryId", async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const companyId = companyForRead(req, res);
      if (!companyId) return;

      const { entryId } = req.params;

      // Allow cancelling both 'waiting' and 'processing' entries (user may leave queue after atomic claim)
      const [updated] = await db
        .update(flowTestQueue)
        .set({ status: 'cancelled', errorMessage: 'Cancelled by user.' })
        .where(
          and(
            eq(flowTestQueue.id, entryId),
            eq(flowTestQueue.userId, userId),
            eq(flowTestQueue.companyId, companyId),
            inArray(flowTestQueue.status, ['waiting', 'processing'])
          )
        )
        .returning();

      if (!updated) {
        // Entry may be completed/failed — that's OK, not an error
        return res.json({ success: true, note: 'Entry was already in a terminal state.' });
      }

      return res.json({ success: true });
    } catch (error: any) {
      logger.error("Error cancelling queue entry:", error);
      return res.status(500).json({ error: "Failed to cancel queue entry" });
    }
  });
}
