/**
 * The only route from an SMS send to the Twilio connector (#357).
 *
 * Order for every send: pre-send gate (suppression, consent, quiet hours), then credentials, then
 * one connector call. A blocked send is recorded through gate.recordBlock and never reaches the
 * connector or the vault. A gate that throws is treated as a block (fail closed).
 *
 * The connector call gets a single attempt: Twilio does not dedupe sends, so the shared runner's
 * retries are turned off here.
 */
import type { PreSendBlockReason, PreSendGate, PreSendSurface } from '../../modules/comms/presend-gate.ts';
import type { SendTransport } from '../../modules/campaigns/ports.ts';
import type { SendJob } from '../../modules/campaigns/types.ts';
import { ConnectorError, type ConnectorCredentials, type ConnectorDefinition } from '../sdk/contract.ts';
import { runAction } from '../sdk/runner.ts';
import type { AuditSink } from '../sdk/audit.ts';
import type { SendSmsResult } from './index.ts';

export interface SmsRoute {
  credentials: ConnectorCredentials;
  from?: string;
  messagingServiceSid?: string;
}

export interface GatedSmsDeps {
  gate: PreSendGate;
  definition: ConnectorDefinition;
  /** Per-company credentials and sender identity. Only called after the gate allows the send. */
  resolveRoute(companyId: string): Promise<SmsRoute>;
  audit: AuditSink;
  timeoutMs?: number;
}

export type GatedSmsResult =
  | { status: 'sent'; externalId: string }
  | { status: 'blocked'; reason: PreSendBlockReason };

export interface GatedSmsRequest {
  companyId: string;
  actorId: string;
  surface: PreSendSurface;
  to: string;
  body: string;
  /** Stable id of the logical message (for example a send job id), recorded in the audit. */
  stableId?: string;
}

export function createGatedSmsSender(deps: GatedSmsDeps) {
  async function send(req: GatedSmsRequest): Promise<GatedSmsResult> {
    const check = { companyId: req.companyId, channel: 'sms', address: req.to, surface: req.surface, actorId: req.actorId };
    let reason: PreSendBlockReason | null = null;
    try {
      const decision = await deps.gate.check(check);
      if (!decision.allowed) reason = decision.reason;
    } catch {
      reason = 'gate_error';
    }
    if (reason !== null) {
      await deps.gate.recordBlock(
        { companyId: req.companyId, channel: 'sms', surface: req.surface, actorId: req.actorId },
        reason,
      );
      return { status: 'blocked', reason };
    }

    const route = await deps.resolveRoute(req.companyId);
    const result = await runAction({
      definition: deps.definition,
      companyId: req.companyId,
      action: 'sendSms',
      input: {
        to: req.to,
        body: req.body,
        ...(route.from !== undefined ? { from: route.from } : {}),
        ...(route.messagingServiceSid !== undefined ? { messagingServiceSid: route.messagingServiceSid } : {}),
      },
      credentials: route.credentials,
      stableId: req.stableId,
      timeoutMs: deps.timeoutMs ?? 10_000,
      retry: { maxAttempts: 1, sleep: async () => {}, random: () => 0 },
      audit: deps.audit,
    });
    const value = result.value as SendSmsResult;
    return { status: 'sent', externalId: value.externalId };
  }

  return { send };
}

/**
 * Campaign transport (SendTransport) that routes every campaign SMS through the gated sender.
 * dispatchJob already checks consent; this is a second check at the last point before the network.
 * A blocked send throws, so the send queue does not treat it as sent.
 */
export function createGatedSmsTransport(sender: ReturnType<typeof createGatedSmsSender>): SendTransport {
  return {
    async send(companyId: string, job: SendJob, content: { subject: string | null; body: string }) {
      const result = await sender.send({
        companyId,
        actorId: 'system',
        surface: 'marketing',
        to: job.address,
        body: content.body,
        stableId: job.id,
      });
      if (result.status === 'blocked') throw new ConnectorError('forbidden', `sms send blocked: ${result.reason}`);
      return { externalId: result.externalId };
    },
  };
}
