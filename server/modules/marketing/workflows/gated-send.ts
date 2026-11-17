// The one outbound path for automated follow-up workflows (#360 outreach, #361 quote and invoice
// follow-up). A workflow never calls a transport directly. Every message is checked by the
// comms pre-send gate (suppression, consent, opt-out, quiet hours in the recipient's timezone)
// immediately before the transport, and a block is recorded before anything is returned.
//
// Order of decisions:
//   1. approval, when the step needs one (for example any payment demand). No gate call, no send.
//   2. pre-send gate. A block is recorded with its reason and nothing is sent.
//   3. quiet hours are reported as 'deferred' so the caller retries on a later run.
//   4. transport. A transport error is reported as 'failed' and is never retried here.
//
// Pure apart from the injected ports. No database, network or host clock.

import type { PreSendBlockReason, PreSendGate, PreSendSurface } from '../../comms/presend-gate.ts';
import type { Channel } from '../../comms/consent.ts';

export interface OutboundMessage {
  companyId: string;
  channel: Channel;
  /** Normalised by the gate. Passed through unchanged here. */
  address: string;
  subject: string | null;
  body: string;
  /** Workflow name, for the audit trail and the transport's own records. */
  workflow: string;
  /** The job, quote, invoice or client the message is about. */
  subjectId: string;
}

export interface GatedSendTransport {
  send(message: OutboundMessage): Promise<{ externalId: string }>;
}

export interface GatedSendPorts {
  gate: PreSendGate;
  transport: GatedSendTransport;
}

export interface GatedSendInput extends OutboundMessage {
  surface: PreSendSurface;
  /** True when the step needs a person's approval before any message goes out. */
  requiresApproval: boolean;
  /** Set by the caller only when a matching approval exists for this exact step and subject. */
  approved: boolean;
}

export type GatedSendOutcome =
  | { status: 'sent'; externalId: string }
  | { status: 'blocked'; reason: PreSendBlockReason | 'approval_required' }
  | { status: 'deferred'; reason: 'quiet_hours' }
  | { status: 'failed' };

export async function gatedSend(ports: GatedSendPorts, input: GatedSendInput): Promise<GatedSendOutcome> {
  if (!ports || !ports.gate || !ports.transport) throw new TypeError('gatedSend: gate and transport required');

  const refs = { messageId: null, threadId: null };
  const who = { companyId: input.companyId, channel: input.channel, surface: input.surface, actorId: 'system' } as const;

  if (input.requiresApproval && !input.approved) {
    return { status: 'blocked', reason: 'approval_required' };
  }

  const decision = await ports.gate.check({
    companyId: input.companyId,
    channel: input.channel,
    address: input.address,
    surface: input.surface,
    actorId: 'system',
  });

  if (decision.allowed === false) {
    // A block is written before it is reported. If the write fails, the error propagates and
    // nothing is sent.
    await ports.gate.recordBlock(who, decision.reason, refs);
    if (decision.reason === 'quiet_hours') return { status: 'deferred', reason: 'quiet_hours' };
    return { status: 'blocked', reason: decision.reason };
  }

  try {
    const sent = await ports.transport.send({
      companyId: input.companyId,
      channel: input.channel,
      address: input.address,
      subject: input.subject,
      body: input.body,
      workflow: input.workflow,
      subjectId: input.subjectId,
    });
    return { status: 'sent', externalId: sent.externalId };
  } catch {
    // Fixed outcome. Provider error text can carry addresses, so it is dropped here.
    return { status: 'failed' };
  }
}
