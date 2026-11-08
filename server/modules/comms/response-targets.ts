// Response-time targets for inbound threads. Pure functions: no store, no clock reads, no network.
// Times are epoch milliseconds. Business hours are evaluated in the IANA timezone given.

export interface BusinessHours {
  /** First business hour, 0-23 (local). */
  startHour: number;
  /** End hour, 0-24 (local, exclusive). When smaller than startHour the window crosses midnight. */
  endHour: number;
  /** IANA timezone, e.g. "Australia/Melbourne". */
  timezone: string;
  /** Business weekdays, 0 = Sunday ... 6 = Saturday. */
  days: number[];
}

export interface DueAtInput {
  receivedAt: number;
  targetMinutes: number;
  businessHours?: BusinessHours;
}

export type BreachStatus = 'replied' | 'breached' | 'open';

export interface BreachStatusInput {
  dueAt: number;
  /** Epoch ms of the first reply, or null/undefined when there is none. */
  repliedAt?: number | null;
  now: number;
}

export type ChannelTargets = Record<string, number> & { default?: number };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Longest run of non-business time the clock will skip before giving up (guards against bad input). */
const MAX_NON_BUSINESS_GAP_MS = 10 * DAY_MS;

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** Local weekday (0 = Sunday) and minutes since local midnight for an instant. */
function wallClock(ms: number, timezone: string): { weekday: number; minuteOfDay: number } {
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of formatterFor(timezone).formatToParts(ms)) {
    if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? 0;
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { weekday, minuteOfDay: hour * 60 + minute };
}

function validateBusinessHours(bh: BusinessHours): void {
  const { startHour, endHour, days } = bh;
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    throw new RangeError('businessHours.startHour must be an integer 0-23');
  }
  if (!Number.isInteger(endHour) || endHour < 0 || endHour > 24) {
    throw new RangeError('businessHours.endHour must be an integer 0-24');
  }
  if (startHour === endHour) {
    throw new RangeError('businessHours.startHour and endHour must differ');
  }
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new RangeError('businessHours.days must be a non-empty list of weekdays 0-6');
  }
  // Throws a RangeError for an unknown timezone.
  formatterFor(bh.timezone);
}

/**
 * True when the whole local minute starting at `ms` counts as business time.
 * For a midnight-crossing window (e.g. 22 to 6) the early-morning part belongs to the
 * previous day's shift, so it counts only when the previous weekday is a business day.
 */
function isBusinessMinute(ms: number, bh: BusinessHours): boolean {
  const { weekday, minuteOfDay } = wallClock(ms, bh.timezone);
  const start = bh.startHour * 60;
  const end = bh.endHour * 60;
  if (start < end) {
    return bh.days.includes(weekday) && minuteOfDay >= start && minuteOfDay < end;
  }
  if (minuteOfDay >= start) return bh.days.includes(weekday);
  if (minuteOfDay < end) return bh.days.includes((weekday + 6) % 7);
  return false;
}

function nextMinuteBoundary(ms: number): number {
  return (Math.floor(ms / MINUTE_MS) + 1) * MINUTE_MS;
}

/**
 * Due time for a reply target. Without businessHours the clock is receivedAt + targetMinutes.
 * With businessHours the clock only runs inside the window, so the due time may fall on a later day.
 * Steps minute by minute through business time, so a long target costs one step per minute.
 */
export function dueAt(input: DueAtInput): number {
  const { receivedAt, targetMinutes, businessHours } = input;
  if (!Number.isFinite(receivedAt)) throw new RangeError('receivedAt must be a finite epoch ms');
  if (!Number.isFinite(targetMinutes) || targetMinutes < 0) {
    throw new RangeError('targetMinutes must be a non-negative number');
  }
  if (!businessHours) return receivedAt + targetMinutes * MINUTE_MS;

  validateBusinessHours(businessHours);

  let remaining = targetMinutes * MINUTE_MS;
  let t = receivedAt;
  let lastBusinessAt = receivedAt;
  while (remaining > 0) {
    if (isBusinessMinute(t, businessHours)) {
      // Run the clock to the end of this minute (or to the due point), whichever is first.
      const step = Math.min(remaining, nextMinuteBoundary(t) - t);
      remaining -= step;
      t += step;
      lastBusinessAt = t;
    } else {
      if (t - lastBusinessAt > MAX_NON_BUSINESS_GAP_MS) {
        throw new RangeError('businessHours never opens within the search window');
      }
      t = nextMinuteBoundary(t);
    }
  }
  return t;
}

/**
 * reply on or before dueAt -> 'replied'. Reply after dueAt -> 'breached'.
 * No reply: now after dueAt -> 'breached', otherwise 'open'.
 */
export function breachStatus(input: BreachStatusInput): BreachStatus {
  const { dueAt: due, repliedAt, now } = input;
  if (repliedAt !== null && repliedAt !== undefined) {
    return repliedAt <= due ? 'replied' : 'breached';
  }
  return now > due ? 'breached' : 'open';
}

/**
 * Target minutes for a channel, falling back to targets.default.
 * Throws an Error with code 'no_target' when the channel has no target and there is no default.
 */
export function targetFor(channel: string, targets: ChannelTargets): number {
  const own = targets[channel];
  if (typeof own === 'number' && Number.isFinite(own) && own >= 0) return own;
  const fallback = targets.default;
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0) return fallback;
  const err = new Error('no_target') as Error & { code: string };
  err.code = 'no_target';
  throw err;
}
