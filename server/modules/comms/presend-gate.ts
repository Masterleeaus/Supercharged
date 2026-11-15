// Pre-send compliance gate. Every inbox and marketing send calls check() before it is queued or
// handed to a transport. A blocked send is recorded through recordBlock() with its reason.
//
// Checks run in this order, and the first failure decides the reason:
//   1. the channel is one the consent model covers, and the address is well formed
//   2. suppression list (bounces, complaints, invalid addresses, unsubscribes)
//   3. consent for this recipient on this channel: opt-out, channel opt-in, quiet hours read in
//      the recipient's own timezone (checkConsent in consent.ts does all three)
// Any error while checking fails closed with 'gate_error'.
//
// No database, network or host clock here: the ports are injected and `now` comes from them.

import {
  CHANNELS,
  checkConsent,
  handleForChannel,
  type Channel,
  type Contact,
  type DateInput,
  type QuietHours,
} from './consent.ts';
import { normaliseAddress, type SuppressionList } from './suppression.ts';

export const PRESEND_BLOCK_REASONS = [
  'unsupported_channel',
  'invalid_address',
  'suppressed',
  'no_consent',
  'channel_not_consented',
  'opted_out',
  'quiet_hours',
  'invalid_contact',
  'gate_error',
] as const;

export type PreSendBlockReason = (typeof PRESEND_BLOCK_REASONS)[number];

export type PreSendDecision = { allowed: true } | { allowed: false; reason: PreSendBlockReason };

/** Which send path asked. Recorded with a block so the audit trail says where it came from. */
export type PreSendSurface = 'inbox' | 'marketing';

export interface PreSendCheck {
  companyId: string;
  channel: Channel | string;
  address: string;
  surface: PreSendSurface;
  /** Staff id, agent id or 'system'. */
  actorId: string;
  /**
   * Quiet-hours window for this send. When omitted, the gate loads the company window through
   * ports.loadQuietHours. When given (null means no window), that value is used as is.
   */
  quietHours?: QuietHours | null;
}

export interface BlockedSendRecord {
  companyId: string;
  channel: Channel | string;
  surface: PreSendSurface;
  actorId: string;
  reason: PreSendBlockReason;
  /** ISO 8601 time from the gate clock. */
  at: string;
  /** Set by the caller when a message row was written for the blocked send. */
  messageId?: string | null;
  threadId?: string | null;
}

export interface PreSendGatePorts {
  /** Company suppression list. Its own checks fail closed for anything it cannot read. */
  suppression: SuppressionList;
  /** The recipient's contact (handles, consent records, timezone). Null when nothing is known. */
  loadContact(companyId: string, channel: Channel, address: string): Promise<Contact | null>;
  /** Company quiet-hours window, or null for none. Read only when the check does not pass one. */
  loadQuietHours(companyId: string): Promise<QuietHours | null>;
  /** Gate clock. */
  now(): DateInput;
  /** Durable record of a blocked send. A failure here propagates, so a block is never silent. */
  recordBlocked(record: BlockedSendRecord): Promise<void>;
}

export interface PreSendGate {
  check(input: PreSendCheck): Promise<PreSendDecision>;
  /** Records a block with its reason. Callers await it and must not queue or send the message. */
  recordBlock(
    input: Pick<PreSendCheck, 'companyId' | 'channel' | 'surface' | 'actorId'>,
    reason: PreSendBlockReason,
    refs?: { messageId?: string | null; threadId?: string | null },
  ): Promise<void>;
}

const CONSENT_CHANNELS: readonly string[] = CHANNELS;

function toIso(value: DateInput): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('gate clock returned an invalid date');
  return date.toISOString();
}

/** The contact must name this recipient on this channel. A record for another address is refused. */
function ownsAddress(contact: Contact, channel: Channel, address: string): boolean {
  const handle = contact.handles?.[handleForChannel(channel)];
  return typeof handle === 'string' && normaliseAddress(channel, handle) === address;
}

export function createPreSendGate(ports: PreSendGatePorts): PreSendGate {
  if (!ports || typeof ports !== 'object') throw new TypeError('presend gate: ports required');
  if (!ports.suppression || typeof ports.suppression.isSuppressed !== 'function') {
    throw new TypeError('presend gate: suppression list required');
  }
  if (typeof ports.loadContact !== 'function') throw new TypeError('presend gate: loadContact required');
  if (typeof ports.loadQuietHours !== 'function') throw new TypeError('presend gate: loadQuietHours required');
  if (typeof ports.now !== 'function') throw new TypeError('presend gate: now required');
  if (typeof ports.recordBlocked !== 'function') throw new TypeError('presend gate: recordBlocked required');

  const block = (reason: PreSendBlockReason): PreSendDecision => ({ allowed: false, reason });

  return {
    async check(input) {
      try {
        const { companyId, channel: rawChannel, address: rawAddress } = input;
        if (!CONSENT_CHANNELS.includes(rawChannel)) return block('unsupported_channel');
        const channel = rawChannel as Channel;

        const address = normaliseAddress(channel, rawAddress);
        if (address === null) return block('invalid_address');

        // Suppression first. It fails closed when the company id is not usable.
        if (ports.suppression.isSuppressed(companyId, { channel, address })) return block('suppressed');

        const contact = await ports.loadContact(companyId, channel, address);
        if (!contact) return block('no_consent');
        if (!ownsAddress(contact, channel, address)) return block('invalid_contact');

        const quietHours = input.quietHours !== undefined
          ? input.quietHours
          : await ports.loadQuietHours(companyId);

        const decision = checkConsent({ channel, contact, now: ports.now(), quietHours });
        if (decision.allowed === true) return { allowed: true };
        return block(decision.reason);
      } catch {
        // Fixed reason. The error text is dropped so no address or provider detail leaks.
        return block('gate_error');
      }
    },

    async recordBlock(input, reason, refs = {}) {
      await ports.recordBlocked({
        companyId: input.companyId,
        channel: input.channel,
        surface: input.surface,
        actorId: input.actorId,
        reason,
        at: toIso(ports.now()),
        messageId: refs.messageId ?? null,
        threadId: refs.threadId ?? null,
      });
    },
  };
}
