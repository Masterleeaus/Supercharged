// Channel-specific consent, contact preferences, quiet hours and opt-out keywords.
// Pure functions only: no database, no network, no clock reads (the caller passes `now`).

export const CHANNELS = [
  'email',
  'sms',
  'whatsapp',
  'telegram',
  'messenger',
  'instagram',
  'phone',
] as const;

export type Channel = (typeof CHANNELS)[number];

export type ConsentSource = 'contact' | 'staff' | 'import' | 'system';

export type DateInput = Date | number | string;

/**
 * One consent record. `channel: 'all'` is only meaningful for opt_out and applies to every
 * channel. An opt_in always covers exactly the channel it names.
 */
export interface ConsentEvent {
  channel: Channel | 'all';
  action: 'opt_in' | 'opt_out';
  at: DateInput;
  source: ConsentSource;
}

export interface ContactHandles {
  email?: string;
  phone?: string;
  telegram?: string;
  messenger?: string;
  instagram?: string;
}

export interface Contact {
  handles?: ContactHandles;
  consents?: ConsentEvent[];
  /** The recipient's IANA timezone, e.g. "Australia/Melbourne". Quiet hours are read in this zone. */
  timezone?: string | null;
}

export interface QuietHours {
  startHour: number;
  endHour: number;
}

export type ConsentReason =
  | 'no_consent'
  | 'opted_out'
  | 'channel_not_consented'
  | 'quiet_hours'
  | 'invalid_contact';

export type ConsentDecision = { allowed: true } | { allowed: false; reason: ConsentReason };

export interface CheckConsentInput {
  channel: Channel;
  contact: Contact | null | undefined;
  now: DateInput;
  /** Company-wide window. It is read in the recipient's timezone (contact.timezone), never the company's. */
  quietHours?: QuietHours | null;
}

// Which contact handle each channel needs. WhatsApp and SMS reach a phone number.
const HANDLE_FOR_CHANNEL: Record<Channel, keyof ContactHandles> = {
  email: 'email',
  sms: 'phone',
  whatsapp: 'phone',
  phone: 'phone',
  telegram: 'telegram',
  messenger: 'messenger',
  instagram: 'instagram',
};

function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

function toMs(value: DateInput): number {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function latest(events: ConsentEvent[]): (ConsentEvent & { ms: number }) | undefined {
  let best: (ConsentEvent & { ms: number }) | undefined;
  for (const event of events) {
    const ms = toMs(event.at);
    if (!best || ms > best.ms) best = { ...event, ms };
  }
  return best;
}

function validateHour(name: string, value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 23) {
    throw new RangeError(`quietHours.${name} must be an integer from 0 to 23`);
  }
}

/** True only for a non-empty string that Intl accepts as an IANA timezone. */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The recipient's timezone from the contact, or null when it is missing or not a valid IANA name. */
export function recipientTimezone(contact: Contact): string | null {
  return isValidTimezone(contact.timezone) ? contact.timezone : null;
}

/**
 * True when `now`, read as a wall-clock hour in `timezone`, falls inside the quiet window.
 * The window is [startHour, endHour). If startHour > endHour it crosses midnight.
 * Equal start and end means no window.
 * `timezone` is required and must be a valid IANA name. There is no default: a missing zone
 * would otherwise fall back to the host's zone, which is a guess.
 */
export function isQuietHours(
  now: DateInput,
  quietHours: QuietHours | null | undefined,
  timezone: string,
): boolean {
  if (!quietHours) return false;
  validateHour('startHour', quietHours.startHour);
  validateHour('endHour', quietHours.endHour);
  const { startHour, endHour } = quietHours;
  if (startHour === endHour) return false;

  const ms = toMs(now);
  if (!Number.isFinite(ms)) throw new RangeError('now is not a valid date');
  if (!isValidTimezone(timezone)) throw new RangeError('timezone must be a valid IANA timezone');

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const hourPart = parts.find((p) => p.type === 'hour');
  if (!hourPart) throw new RangeError(`could not read the hour for timezone ${timezone}`);
  const hour = Number(hourPart.value);

  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/**
 * Decide whether a message may go to this contact on this channel right now.
 *
 * Order of checks: invalid input, then opt-out, then consent, then quiet hours.
 * Quiet hours are read in the recipient's timezone (contact.timezone). When a window is set and
 * the contact has no valid timezone, the send is refused as 'invalid_contact' (fail closed).
 * With no window set, the timezone is not needed and is not checked.
 * - An opt-out on the channel (or channel 'all') is permanent. No later opt-in on that channel
 *   reinstates it, whatever its source or timestamp. This holds through contact merges too.
 * - Consent is per channel. A channel opt-in never covers another channel.
 * - 'no_consent' means the contact has no consent records at all.
 *   'channel_not_consented' means records exist, but none grants this channel.
 */
export function checkConsent(input: CheckConsentInput): ConsentDecision {
  const { channel, contact, now, quietHours } = input;

  if (!isChannel(channel)) return { allowed: false, reason: 'invalid_contact' };
  if (!contact || typeof contact !== 'object') return { allowed: false, reason: 'invalid_contact' };

  const handle = contact.handles?.[HANDLE_FOR_CHANNEL[channel]];
  if (typeof handle !== 'string' || handle.trim() === '') {
    return { allowed: false, reason: 'invalid_contact' };
  }

  const events = contact.consents ?? [];
  for (const event of events) {
    const badTime = !Number.isFinite(toMs(event.at));
    const badChannel = event.channel !== 'all' && !isChannel(event.channel);
    if (badTime || badChannel) {
      return { allowed: false, reason: 'invalid_contact' };
    }
  }

  if (events.length === 0) return { allowed: false, reason: 'no_consent' };

  const optOut = latest(
    events.filter((e) => e.action === 'opt_out' && (e.channel === channel || e.channel === 'all')),
  );
  const optIn = latest(events.filter((e) => e.action === 'opt_in' && e.channel === channel));

  // Owner decision 47: an opt-out stays in force, except that a contact's own SMS STOP is lifted
  // by a later START from the same contact. Every other opt-out (admin, merge, other channels)
  // is permanent, and no other opt-in reinstates it.
  if (optOut) {
    const startReinstates =
      channel === 'sms' &&
      optOut.channel === 'sms' &&
      optOut.source === 'contact' &&
      optIn !== undefined &&
      optIn.source === 'contact' &&
      optIn.ms > optOut.ms;
    if (!startReinstates) return { allowed: false, reason: 'opted_out' };
  }

  if (!optIn) return { allowed: false, reason: 'channel_not_consented' };

  if (quietHours) {
    const timezone = recipientTimezone(contact);
    if (timezone === null) return { allowed: false, reason: 'invalid_contact' };
    if (isQuietHours(now, quietHours, timezone)) return { allowed: false, reason: 'quiet_hours' };
  }

  return { allowed: true };
}

export interface OptOutKeywordResult {
  optOut: boolean;
  optIn?: boolean;
}

const OPT_OUT_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'END', 'CANCEL', 'QUIT']);
const OPT_IN_WORDS = new Set(['START', 'YES']);

/**
 * Read an inbound message as a consent keyword. The whole trimmed message must be the keyword,
 * compared case-insensitively. "stop it" and "STOP." do not match.
 */
export function parseOptOutKeyword(text: unknown): OptOutKeywordResult {
  if (typeof text !== 'string') return { optOut: false };
  const word = text.trim().toUpperCase();
  if (OPT_OUT_WORDS.has(word)) return { optOut: true };
  if (OPT_IN_WORDS.has(word)) return { optOut: false, optIn: true };
  return { optOut: false };
}
