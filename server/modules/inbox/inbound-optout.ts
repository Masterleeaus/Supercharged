/*
 * Inbound STOP and START on the inbox path. Uses the same keyword parser and suppression rules as
 * the Plivo SMS route (comms/inbound-optout.ts), so one keyword means the same thing on both paths.
 * Pure orchestration: the suppression list and the reply sender are injected.
 */
import { handleInboundOptOut } from '../comms/inbound-optout.ts';
import { parseOptOutKeyword } from '../comms/consent.ts';
import type { SuppressionList } from '../comms/suppression.ts';
import type { Channel } from './types.ts';

/** Channels where an inbound STOP or START is read as an opt-out keyword. Same set as the phone-number channels on the SMS path. */
export const OPT_OUT_KEYWORD_CHANNELS: readonly Extract<Channel, 'sms' | 'whatsapp' | 'phone'>[] = ['sms', 'whatsapp', 'phone'];

/** Channels the suppression list can hold. Sends on other channels are not checked against it. */
export const SUPPRESSIBLE_CHANNELS: readonly Channel[] = ['email', 'sms', 'whatsapp', 'phone'];

/**
 * Confirmation replies. Placeholder wording until compliance signs it off. They are the only
 * text this path sends, and they go out only after the suppression change has been recorded.
 */
export const STOP_CONFIRMATION =
  'You are unsubscribed and will get no more messages from us on this channel. Reply START to subscribe again.';
export const START_CONFIRMATION =
  'You are subscribed again and may receive messages from us on this channel. Reply STOP to unsubscribe.';

export interface OptOutReply {
  companyId: string;
  channel: Channel;
  address: string;
  kind: 'stop' | 'start';
  text: string;
  /** Stable per inbound delivery. A transport must treat a repeat key as already sent. */
  idempotencyKey: string;
}

/** Hands one confirmation to the transport layer. Rejecting means the reply was not handed over. */
export type OptOutReplySender = (reply: OptOutReply) => Promise<void>;

export interface InboundKeywordInput {
  suppression: SuppressionList;
  sendReply: OptOutReplySender;
  companyId: string;
  channel: Channel;
  address: string;
  body: string;
  externalId: string;
  now: Date;
}

/**
 * Applies an inbound STOP or START to the suppression list and sends the confirmation.
 *
 * - 'none': not a keyword on this channel, or START with nothing to lift. No change, no reply.
 * - 'recorded': the change is stored (STOP suppressed, or START lifted an unsubscribe) and the
 *   confirmation was handed over.
 * - 'failed': the suppression write was refused. Nothing was recorded, so the caller must not store
 *   the message as handled; the delivery should be retried.
 *
 * Order: suppression first, then the reply. Both steps are idempotent for the same inbound delivery.
 */
function isOptOutKeywordChannel(channel: Channel): channel is 'sms' | 'whatsapp' | 'phone' {
  return OPT_OUT_KEYWORD_CHANNELS.some((allowed) => allowed === channel);
}

export async function applyInboundKeyword(input: InboundKeywordInput): Promise<'none' | 'recorded' | 'failed'> {
  const { suppression, sendReply, companyId, channel, address, body, externalId, now } = input;
  if (!isOptOutKeywordChannel(channel)) return 'none';
  const keyword = parseOptOutKeyword(body);
  if (!keyword.optOut && !keyword.optIn) return 'none';

  const result = handleInboundOptOut({ companyId, channel, from: address, body, suppression, now });
  if (result.action === 'not_changed' && result.reason !== 'not_opt_out') return 'failed';
  if (result.action === 'none' || result.action === 'not_changed') return 'none';

  const kind = result.action === 'suppressed' ? 'stop' : 'start';
  await sendReply({
    companyId,
    channel,
    address,
    kind,
    text: kind === 'stop' ? STOP_CONFIRMATION : START_CONFIRMATION,
    idempotencyKey: `optout|${companyId}|${channel}|${externalId}`,
  });
  return 'recorded';
}
