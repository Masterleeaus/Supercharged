/**
 * Slot and availability math. The PHP BookingRuntime::available() only listed busy rows and never
 * computed free slots, and it ignored calendar.availability and calendar.timezone. This module adds
 * both, using explicit timezone conversion via Intl (no date library).
 *
 * Conflict rule (used by slot filtering and by the storage overlap guard):
 *   two intervals conflict when a.start < b.end + buffer AND b.start < a.end + buffer.
 * With buffer 0 this is ordinary half-open overlap. With buffer N it requires a gap of at least N minutes.
 */
import type { CalendarRecord, DayHours, Interval, Weekday } from "./types.ts";
import { WEEKDAYS } from "./types.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const MAX_RANGE_DAYS = 31;

export function intervalsConflict(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date, bufferMs = 0): boolean {
  return aStart.getTime() < bEnd.getTime() + bufferMs && bStart.getTime() < aEnd.getTime() + bufferMs;
}

/** IANA timezone check. Same behaviour as isIanaTimezone in booking-agent/schemas.ts, kept local (see DECISIONS.md). */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Parses "HH:MM" (00:00 to 23:59). Returns null for anything else. */
export function parseTimeOfDay(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

/** Wall-clock date and time of an instant in a timezone. */
function wallPartsOf(instant: Date, timezone: string): WallParts {
  const out: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset of the timezone from UTC at an instant, in milliseconds (positive east of UTC). */
function offsetAt(instant: Date, timezone: string): number {
  const wall = wallPartsOf(instant, timezone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const wholeSecondInstant = Math.floor(instant.getTime() / 1000) * 1000;
  return wallAsUtc - wholeSecondInstant;
}

/**
 * Converts a wall-clock time in a timezone to an instant. Re-checks the offset at the result so that
 * times on either side of a DST change resolve correctly. A wall time that falls in a DST gap resolves to
 * one of the two neighbouring instants (documented in DECISIONS.md).
 */
export function zonedWallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = offsetAt(new Date(guess), timezone);
  let result = guess - firstOffset;
  const secondOffset = offsetAt(new Date(result), timezone);
  if (secondOffset !== firstOffset) result = guess - secondOffset;
  return new Date(result);
}

/**
 * Working windows of a calendar that intersect [from, to). Windows are NOT clipped to the range, so a
 * caller can check whether a requested time sits fully inside working hours. Returns [] when the
 * calendar has no availability (fail closed: no hours means no bookable time).
 */
export function workingWindows(calendar: CalendarRecord, from: Date, to: Date): Interval[] {
  if (!calendar.availability || to.getTime() <= from.getTime()) return [];
  const timezone = calendar.timezone;
  const fromWall = wallPartsOf(from, timezone);
  const toWall = wallPartsOf(to, timezone);
  // Calendar-date arithmetic in UTC. One day of padding on each side covers offsets up to 24h.
  const firstDay = Date.UTC(fromWall.year, fromWall.month - 1, fromWall.day) - DAY_MS;
  const lastDay = Date.UTC(toWall.year, toWall.month - 1, toWall.day) + DAY_MS;
  const windows: Interval[] = [];

  for (let cursor = firstDay; cursor <= lastDay; cursor += DAY_MS) {
    const date = new Date(cursor);
    const weekday: Weekday = WEEKDAYS[date.getUTCDay()];
    const hours: DayHours | undefined = calendar.availability[weekday];
    if (!hours || !hours.enabled) continue;
    const start = parseTimeOfDay(hours.start);
    const end = parseTimeOfDay(hours.end);
    if (!start || !end) continue;
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const windowStart = zonedWallTimeToInstant(y, m, d, start.hour, start.minute, timezone);
    const windowEnd = zonedWallTimeToInstant(y, m, d, end.hour, end.minute, timezone);
    if (windowStart.getTime() < to.getTime() && windowEnd.getTime() > from.getTime()) {
      windows.push({ start: windowStart, end: windowEnd });
    }
  }
  return windows;
}

/** True when [start, end) lies fully inside one working window. */
export function coveredByWindows(windows: Interval[], start: Date, end: Date): boolean {
  return windows.some((w) => w.start.getTime() <= start.getTime() && w.end.getTime() >= end.getTime());
}

/**
 * Splits each window into back-to-back slots of durationMs, skipping slots that start before now and
 * slots that conflict with a busy interval under the calendar buffer.
 */
export function generateSlots(
  windows: Interval[],
  busy: Interval[],
  durationMs: number,
  bufferMs: number,
  now: Date,
): Interval[] {
  const slots: Interval[] = [];
  for (const window of windows) {
    for (let t = window.start.getTime(); t + durationMs <= window.end.getTime(); t += durationMs) {
      if (t < now.getTime()) continue;
      const slotStart = new Date(t);
      const slotEnd = new Date(t + durationMs);
      const taken = busy.some((b) => intervalsConflict(b.start, b.end, slotStart, slotEnd, bufferMs));
      if (!taken) slots.push({ start: slotStart, end: slotEnd });
    }
  }
  return slots;
}
