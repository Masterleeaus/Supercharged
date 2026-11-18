// Per-tenant registry of live inbound sessions (#333). Keys include the company, so a call id
// from one company can never reach another company's session.

import { newInboundSession, reduceInbound, type InboundEvent, type InboundEffect, type InboundSession, type ReduceResult } from './fsm.ts';

export class InboundRegistry {
  private readonly sessions = new Map<string, InboundSession>();

  private key(companyId: string, callId: string): string {
    return `${companyId}\u0000${callId}`;
  }

  open(companyId: string, callId: string): InboundSession {
    const k = this.key(companyId, callId);
    const existing = this.sessions.get(k);
    if (existing) return existing;
    const session = newInboundSession(companyId, callId);
    this.sessions.set(k, session);
    return session;
  }

  get(companyId: string, callId: string): InboundSession | null {
    return this.sessions.get(this.key(companyId, callId)) ?? null;
  }

  /** Applies an event against the stored session. A stale or duplicate event changes nothing. */
  apply(companyId: string, callId: string, expectedVersion: number, event: InboundEvent): ReduceResult & { effects?: InboundEffect[] } {
    const current = this.get(companyId, callId);
    if (!current) return { ok: false, reason: 'call_mismatch' };
    const result = reduceInbound(current, event, expectedVersion);
    if (result.ok) this.sessions.set(this.key(companyId, callId), result.session);
    return result;
  }
}
