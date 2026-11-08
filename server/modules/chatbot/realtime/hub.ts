/*
 * Company-keyed registry of open streams. The hub is the only place that decides who receives an event.
 *
 * Routing rule: a frame reaches a stream only when the stream's companyId equals the company the frame names.
 * A company id that is not a UUID routes to nobody (fails closed).
 */
import { isCompanyId } from "../../../infrastructure/database/tenant-context.ts";
import type { InboxEvent } from "../inbox/event-publisher.ts";
import { formatSseFrame, type SubscriberScope } from "./types.ts";

export interface SseSubscriber {
  readonly id: string;
  readonly companyId: string;
  readonly scope: SubscriberScope;
  /** Writes one formatted chunk. Returns false when the stream can no longer take data. */
  write(chunk: string): boolean;
  /** Ends the response and releases timers. Called once, by the hub, when the stream is removed. */
  end(): void;
}

export interface SseHub {
  /** Adds a stream and returns its release function. Release is idempotent. */
  register(subscriber: SseSubscriber): () => void;
  /** Sends one inbox event to the staff streams of event.companyId. Returns how many streams took it. */
  routeInbox(event: InboxEvent): number;
  /** Sends a frame to staff streams and to customer streams on this conversation, all inside companyId. */
  routeToConversation(companyId: string, conversationId: string, frameName: string, data: Record<string, unknown>): number;
  /** Sends a frame to the staff streams of companyId only. Customer streams never receive it. */
  routeToStaff(companyId: string, frameName: string, data: Record<string, unknown>): number;
  subscriberCount(companyId?: string): number;
  /** Ends every stream. The hub refuses new streams afterwards. Used at shutdown. */
  closeAll(): void;
}

/** Same stream identity: one staff member in a company, or one customer conversation in a company. */
function sameIdentity(a: SubscriberScope, b: SubscriberScope): boolean {
  if (a.kind === "staff" && b.kind === "staff") return a.staffId === b.staffId;
  if (a.kind === "customer" && b.kind === "customer") return a.conversationId === b.conversationId;
  return false;
}

export function createSseHub(): SseHub {
  const byCompany = new Map<string, Map<string, SseSubscriber>>();
  let shuttingDown = false;

  function remove(sub: SseSubscriber): boolean {
    const bucket = byCompany.get(sub.companyId);
    if (!bucket || bucket.get(sub.id) !== sub) return false;
    bucket.delete(sub.id);
    if (bucket.size === 0) byCompany.delete(sub.companyId);
    try {
      sub.end();
    } catch {
      // The socket is already gone. Nothing else to release.
    }
    return true;
  }

  function snapshot(companyId: string): SseSubscriber[] {
    return [...(byCompany.get(companyId)?.values() ?? [])];
  }

  function deliver(targets: SseSubscriber[], chunk: string): number {
    let delivered = 0;
    for (const sub of targets) {
      let ok = false;
      try {
        ok = sub.write(chunk);
      } catch {
        ok = false;
      }
      if (ok) delivered += 1;
      else remove(sub);
    }
    return delivered;
  }

  return {
    register(subscriber) {
      if (!isCompanyId(subscriber.companyId)) {
        throw new TypeError("Realtime stream needs a company id");
      }
      if (shuttingDown) {
        subscriber.end();
        return () => {};
      }
      // One stream per identity. A new connection replaces the old one: per staff member per company, and per
      // conversation for customers (a reload or a second tab takes over the stream).
      for (const other of snapshot(subscriber.companyId)) {
        if (sameIdentity(other.scope, subscriber.scope)) remove(other);
      }
      let bucket = byCompany.get(subscriber.companyId);
      if (!bucket) {
        bucket = new Map();
        byCompany.set(subscriber.companyId, bucket);
      }
      bucket.set(subscriber.id, subscriber);
      return () => {
        remove(subscriber);
      };
    },

    routeInbox(event) {
      if (!isCompanyId(event.companyId)) return 0;
      const occurred = event.occurredAt instanceof Date && !Number.isNaN(event.occurredAt.getTime())
        ? event.occurredAt.toISOString()
        : null;
      const chunk = formatSseFrame(event.type, {
        conversationId: event.conversationId,
        occurredAt: occurred,
        data: event.data,
      });
      const targets = snapshot(event.companyId).filter((sub) => sub.scope.kind === "staff");
      return deliver(targets, chunk);
    },

    routeToStaff(companyId, frameName, data) {
      if (!isCompanyId(companyId)) return 0;
      const chunk = formatSseFrame(frameName, data);
      const targets = snapshot(companyId).filter((sub) => sub.scope.kind === "staff");
      return deliver(targets, chunk);
    },

    routeToConversation(companyId, conversationId, frameName, data) {
      if (!isCompanyId(companyId)) return 0;
      const chunk = formatSseFrame(frameName, { conversationId, ...data });
      const targets = snapshot(companyId).filter(
        (sub) =>
          sub.scope.kind === "staff" ||
          (sub.scope.kind === "customer" && sub.scope.conversationId === conversationId),
      );
      return deliver(targets, chunk);
    },

    subscriberCount(companyId) {
      if (companyId !== undefined) return byCompany.get(companyId)?.size ?? 0;
      let total = 0;
      for (const bucket of byCompany.values()) total += bucket.size;
      return total;
    },

    closeAll() {
      shuttingDown = true;
      for (const bucket of [...byCompany.values()]) {
        for (const sub of [...bucket.values()]) remove(sub);
      }
    },
  };
}
