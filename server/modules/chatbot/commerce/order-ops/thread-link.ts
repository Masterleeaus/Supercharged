/**
 * Links a communication thread to a unified order. Port of UnifiedOrderWorkbenchRuntime::linkCommunicationThread.
 *
 * Rules, each recorded in DECISIONS.md:
 *  - Owner only, as the other workbench tools are.
 *  - The order and the thread must both belong to the chatbot and the company. Otherwise the answer is 404.
 *  - A thread links once. The same thread linked again to the same order returns the existing link. A link to a
 *    different order is refused with 409 and nothing is written.
 *  - The idempotency key works as in the workbench: the same key with the same request returns the stored action,
 *    and the same key with another request is refused with 422.
 *  - The link is recorded as a workbench action, so it is audited. The thread table is not written, because the
 *    conversational slice owns it (see DECISIONS.md, change request).
 */
import { hashOf } from "./canonical.ts";
import type { CommunicationThreadPort } from "./ports.ts";
import type { OrderOpsStore } from "./storage.ts";
import type { WorkbenchActor } from "./workbench.ts";
import { OrderOpsError, type WorkbenchAction } from "./types.ts";

export const LINK_THREAD_ACTION = "link_communication_thread";

export interface LinkThreadInput {
  chatbotId: string;
  orderId: string;
  threadId: string;
  idempotencyKey: string;
}

export interface ThreadLinkDeps {
  store: OrderOpsStore;
  threads: CommunicationThreadPort;
  now?: () => Date;
}

function threadIdOf(action: WorkbenchAction): string | null {
  const value = (action.proposal as { threadId?: unknown }).threadId;
  return typeof value === "string" ? value : null;
}

export function createThreadLinker(deps: ThreadLinkDeps) {
  const now = deps.now ?? (() => new Date());

  async function linkCommunicationThread(companyId: string, actor: WorkbenchActor, input: LinkThreadInput): Promise<WorkbenchAction> {
    if (actor.userId === null || actor.userId !== actor.chatbotOwnerId) {
      throw new OrderOpsError("Only the authenticated chatbot owner can link communication threads.", 422);
    }
    const key = input.idempotencyKey.trim();
    if (key === "" || key.length > 191) {
      throw new OrderOpsError("A non-empty idempotency key of at most 191 characters is required.");
    }

    const order = await deps.store.unifiedOrders.get(companyId, input.orderId);
    if (!order || order.chatbotId !== input.chatbotId) throw new OrderOpsError("Order not found.", 404);
    const thread = await deps.threads.find(companyId, input.chatbotId, input.threadId);
    if (!thread || thread.chatbotId !== input.chatbotId) throw new OrderOpsError("Communication thread not found.", 404);

    const userId = actor.userId;
    const proposal = { threadId: thread.id };
    const requestHash = hashOf({ unifiedOrderId: order.id, actionType: LINK_THREAD_ACTION, proposal });

    return deps.store.transaction(async (tx) => {
      const sameKey = await tx.actions.find(companyId, (a) => a.chatbotId === input.chatbotId && a.idempotencyKey === key);
      if (sameKey) {
        const matches = sameKey.actionType === LINK_THREAD_ACTION && sameKey.unifiedOrderId === order.id && sameKey.requestHash === requestHash;
        if (!matches) throw new OrderOpsError("Idempotency key was already used for a different order workbench request.", 422);
        return sameKey;
      }

      const linked = await tx.actions.find(
        companyId,
        (a) => a.chatbotId === input.chatbotId && a.actionType === LINK_THREAD_ACTION && a.status === "completed" && threadIdOf(a) === thread.id,
      );
      if (linked) {
        if (linked.unifiedOrderId === order.id) return linked;
        throw new OrderOpsError("This communication thread is already linked to another order.", 409);
      }

      const at = now();
      return tx.actions.insert(companyId, {
        chatbotId: input.chatbotId,
        unifiedOrderId: order.id,
        exceptionId: null,
        actionType: LINK_THREAD_ACTION,
        status: "completed",
        idempotencyKey: key,
        requestHash,
        requestedByUserId: userId,
        assignedToUserId: null,
        amount: null,
        currency: null,
        sourceHash: order.sourceHash,
        proposal,
        result: { thread_id: thread.id, unified_order_id: order.id, linked_at: at.toISOString() },
        expiresAt: null,
        executedAt: at,
        createdAt: at,
      });
    });
  }

  /** The order a thread is linked to, or null. Another company's or chatbot's link is never returned. */
  async function linkedOrderFor(companyId: string, chatbotId: string, threadId: string): Promise<string | null> {
    const link = await deps.store.actions.find(
      companyId,
      (a) => a.chatbotId === chatbotId && a.actionType === LINK_THREAD_ACTION && a.status === "completed" && threadIdOf(a) === threadId,
    );
    return link ? link.unifiedOrderId : null;
  }

  return { linkCommunicationThread, linkedOrderFor };
}

export type ThreadLinker = ReturnType<typeof createThreadLinker>;
