/**
 * The only route from a Telegram send to the Telegram connector (#357, gate from #336).
 *
 * Order for every send: pre-send gate (suppression, consent, quiet hours), then credentials, then one connector
 * call. A blocked send is recorded through gate.recordBlock and never reaches the connector or the vault. A gate
 * that throws is treated as a block (fail closed). The connector call gets a single attempt, because Telegram
 * does not dedupe sends.
 */
import type { PreSendBlockReason, PreSendGate, PreSendSurface } from '../../modules/comms/presend-gate.ts';
import type { ConnectorCredentials, ConnectorDefinition } from '../sdk/contract.ts';
import { runAction } from '../sdk/runner.ts';
import type { AuditSink } from '../sdk/audit.ts';

export interface TelegramRoute {
  credentials: ConnectorCredentials;
}

export interface GatedTelegramDeps {
  gate: PreSendGate;
  definition: ConnectorDefinition;
  /** Per-company bot credentials. Only called after the gate allows the send. */
  resolveRoute(companyId: string): Promise<TelegramRoute>;
  audit: AuditSink;
  timeoutMs?: number;
}

export interface GatedTelegramRequest {
  companyId: string;
  actorId: string;
  surface: PreSendSurface;
  chatId: string | number;
  text: string;
  replyToMessageId?: number;
  /** Stable id of the logical message, recorded in the audit. */
  stableId?: string;
}

export type GatedTelegramResult =
  | { status: 'sent'; externalId: string }
  | { status: 'blocked'; reason: PreSendBlockReason };

export function createGatedTelegramSender(deps: GatedTelegramDeps) {
  async function send(req: GatedTelegramRequest): Promise<GatedTelegramResult> {
    const address = String(req.chatId);
    const check = { companyId: req.companyId, channel: 'telegram', address, surface: req.surface, actorId: req.actorId };
    let reason: PreSendBlockReason | null = null;
    try {
      const decision = await deps.gate.check(check);
      if (decision.allowed === false) reason = decision.reason;
    } catch {
      reason = 'gate_error';
    }
    if (reason !== null) {
      await deps.gate.recordBlock(
        { companyId: req.companyId, channel: 'telegram', surface: req.surface, actorId: req.actorId },
        reason,
      );
      return { status: 'blocked', reason };
    }

    const route = await deps.resolveRoute(req.companyId);
    const result = await runAction({
      definition: deps.definition,
      companyId: req.companyId,
      action: 'sendMessage',
      input: {
        chatId: req.chatId,
        text: req.text,
        ...(req.replyToMessageId !== undefined ? { replyToMessageId: req.replyToMessageId } : {}),
      },
      credentials: route.credentials,
      stableId: req.stableId,
      timeoutMs: deps.timeoutMs ?? 15_000,
      retry: { maxAttempts: 1, sleep: async () => {}, random: () => 0 },
      audit: deps.audit,
    });
    return { status: 'sent', externalId: (result.value as { externalId: string }).externalId };
  }

  return { send };
}
