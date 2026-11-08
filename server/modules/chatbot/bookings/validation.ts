/**
 * Input validation for booking calls. Every object is checked for unknown keys, so a companyId or a
 * status smuggled into a payload is rejected rather than trusted. The PHP models used $guarded = [],
 * which allowed mass assignment of any column; this port has no such path.
 */
import { ChatbotError } from "../chatbot-scope.ts";
import { MAX_RANGE_DAYS, parseTimeOfDay, isValidTimezone } from "./availability.ts";
import {
  REMINDER_CHANNELS,
  WEEKDAYS,
  type NewCalendar,
  type NewReminder,
  type ReminderChannel,
  type WeeklyAvailability,
} from "./types.ts";

export class BookingValidationError extends ChatbotError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Validation failed: ${issues.join("; ")}`, 422);
    this.name = "BookingValidationError";
    this.issues = issues;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;
const MAX_METADATA_BYTES = 4096;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const DEFAULT_DURATION_MINUTES = 30;
const MAX_BUFFER_MINUTES = 240;

export interface AppointmentInput {
  calendarId: string;
  conversationId: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  startsAt: Date;
  endsAt: Date;
  metadata: Record<string, unknown> | null;
}

export interface RangeQuery {
  from: Date;
  to: Date;
  durationMinutes: number;
}

type Obj = Record<string, unknown>;

function asObject(value: unknown, issues: string[], label: string): Obj | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(`${label} must be an object`);
    return null;
  }
  return value as Obj;
}

function rejectUnknownKeys(obj: Obj, allowed: readonly string[], issues: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) issues.push(`unknown field "${key}"`);
  }
}

function readText(obj: Obj, key: string, max: number, issues: string[], required: boolean): string | null {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") {
    if (required) issues.push(`${key} is required`);
    return null;
  }
  if (typeof raw !== "string") {
    issues.push(`${key} must be a string`);
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (required) issues.push(`${key} is required`);
    return null;
  }
  if (trimmed.length > max) {
    issues.push(`${key} must be at most ${max} characters`);
    return null;
  }
  return trimmed;
}

function readInstant(obj: Obj, key: string, issues: string[]): Date | null {
  const raw = obj[key];
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    issues.push(`${key} must be ISO 8601 with an offset or Z`);
    return null;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    issues.push(`${key} is not a valid date`);
    return null;
  }
  return date;
}

function readMinutes(obj: Obj, key: string, min: number, max: number, fallback: number, issues: string[]): number {
  const raw = obj[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    issues.push(`${key} must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return raw;
}

function readContactEmail(obj: Obj, issues: string[]): string | null {
  const email = readText(obj, "customer_email", 254, issues, false);
  if (email !== null && !EMAIL_RE.test(email)) issues.push("customer_email is not a valid email");
  return email;
}

function readContactPhone(obj: Obj, issues: string[]): string | null {
  const phone = readText(obj, "customer_phone", 16, issues, false);
  if (phone !== null && !E164_RE.test(phone)) issues.push("customer_phone must be E.164 (for example +61400000000)");
  return phone;
}

function readMetadata(obj: Obj, issues: string[]): Record<string, unknown> | null {
  const raw = obj.metadata;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push("metadata must be an object");
    return null;
  }
  const serialised = JSON.stringify(raw);
  if (Buffer.byteLength(serialised, "utf8") > MAX_METADATA_BYTES) {
    issues.push(`metadata must be at most ${MAX_METADATA_BYTES} bytes`);
    return null;
  }
  return raw as Record<string, unknown>;
}

function validateWeeklyAvailability(raw: unknown, issues: string[]): WeeklyAvailability | null {
  if (raw === undefined || raw === null) return null;
  const obj = asObject(raw, issues, "availability");
  if (!obj) return null;
  rejectUnknownKeys(obj, WEEKDAYS, issues);
  const out: WeeklyAvailability = {};
  for (const day of WEEKDAYS) {
    const entry = obj[day];
    if (entry === undefined) continue;
    const dayObj = asObject(entry, issues, `availability.${day}`);
    if (!dayObj) continue;
    rejectUnknownKeys(dayObj, ["enabled", "start", "end"], issues);
    if (typeof dayObj.enabled !== "boolean") {
      issues.push(`availability.${day}.enabled must be a boolean`);
      continue;
    }
    const start = parseTimeOfDay(dayObj.start);
    const end = parseTimeOfDay(dayObj.end);
    if (!start || !end) {
      issues.push(`availability.${day} start and end must be HH:MM`);
      continue;
    }
    if (dayObj.enabled && start.hour * 60 + start.minute >= end.hour * 60 + end.minute) {
      issues.push(`availability.${day} end must be after start`);
      continue;
    }
    out[day] = { enabled: dayObj.enabled, start: dayObj.start as string, end: dayObj.end as string };
  }
  return out;
}

function throwIfIssues(issues: string[]): void {
  if (issues.length > 0) throw new BookingValidationError(issues);
}

export function validateCalendarInput(input: unknown): NewCalendar {
  const issues: string[] = [];
  const obj = asObject(input, issues, "calendar");
  if (!obj) throwIfIssues(issues);
  const body = obj as Obj;
  rejectUnknownKeys(body, ["name", "timezone", "availability", "buffer_minutes"], issues);
  const name = readText(body, "name", 255, issues, true) ?? "";
  const timezone = readText(body, "timezone", 64, issues, true) ?? "";
  if (timezone && !isValidTimezone(timezone)) issues.push("timezone must be an IANA timezone");
  const availability = validateWeeklyAvailability(body.availability, issues);
  const bufferMinutes = readMinutes(body, "buffer_minutes", 0, MAX_BUFFER_MINUTES, 0, issues);
  throwIfIssues(issues);
  return { name, timezone, availability, bufferMinutes };
}

export function validateAppointmentInput(input: unknown, now: Date): AppointmentInput {
  const issues: string[] = [];
  const obj = asObject(input, issues, "appointment");
  if (!obj) throwIfIssues(issues);
  const body = obj as Obj;
  rejectUnknownKeys(
    body,
    [
      "calendar_id",
      "conversation_id",
      "customer_name",
      "customer_email",
      "customer_phone",
      "starts_at",
      "ends_at",
      "metadata",
    ],
    issues,
  );
  const calendarId = readText(body, "calendar_id", 64, issues, true) ?? "";
  const conversationId = readText(body, "conversation_id", 64, issues, false);
  const customerName = readText(body, "customer_name", 255, issues, true) ?? "";
  const customerEmail = readContactEmail(body, issues);
  const customerPhone = readContactPhone(body, issues);
  if (customerEmail === null && customerPhone === null) {
    issues.push("customer_email or customer_phone is required so the business can confirm the booking");
  }
  const startsAt = readInstant(body, "starts_at", issues);
  const endsAt = readInstant(body, "ends_at", issues);
  if (startsAt && endsAt) {
    const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
    if (minutes <= 0) issues.push("ends_at must be after starts_at");
    else if (minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) {
      issues.push(`appointment length must be ${MIN_DURATION_MINUTES} to ${MAX_DURATION_MINUTES} minutes`);
    }
  }
  if (startsAt && startsAt.getTime() < now.getTime()) issues.push("starts_at must not be in the past");
  const metadata = readMetadata(body, issues);
  throwIfIssues(issues);
  return {
    calendarId,
    conversationId,
    customerName,
    customerEmail,
    customerPhone,
    startsAt: startsAt as Date,
    endsAt: endsAt as Date,
    metadata,
  };
}

export function validateRangeQuery(input: unknown, maxDays = MAX_RANGE_DAYS): RangeQuery {
  const issues: string[] = [];
  const obj = asObject(input, issues, "query");
  if (!obj) throwIfIssues(issues);
  const body = obj as Obj;
  rejectUnknownKeys(body, ["from", "to", "duration_minutes"], issues);
  const from = readInstant(body, "from", issues);
  const to = readInstant(body, "to", issues);
  const durationMinutes = readMinutes(
    body,
    "duration_minutes",
    MIN_DURATION_MINUTES,
    MAX_DURATION_MINUTES,
    DEFAULT_DURATION_MINUTES,
    issues,
  );
  if (from && to) {
    const spanMs = to.getTime() - from.getTime();
    if (spanMs <= 0) issues.push("to must be after from");
    else if (spanMs > maxDays * 24 * 60 * 60 * 1000) issues.push(`range must be at most ${maxDays} days`);
  }
  throwIfIssues(issues);
  return { from: from as Date, to: to as Date, durationMinutes };
}

export function validateReminderInput(input: unknown, appointmentId: string): NewReminder {
  const issues: string[] = [];
  const obj = asObject(input, issues, "reminder");
  if (!obj) throwIfIssues(issues);
  const body = obj as Obj;
  rejectUnknownKeys(body, ["channel", "send_at"], issues);
  const channel = body.channel;
  if (typeof channel !== "string" || !(REMINDER_CHANNELS as readonly string[]).includes(channel)) {
    issues.push(`channel must be one of ${REMINDER_CHANNELS.join(", ")}`);
  }
  const sendAt = readInstant(body, "send_at", issues);
  throwIfIssues(issues);
  return { appointmentId, channel: channel as ReminderChannel, sendAt: sendAt as Date };
}

/** Free-text reason for a status change. Optional, at most 500 characters. */
export function validateReason(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 500) {
    throw new BookingValidationError(["reason must be a string of at most 500 characters"]);
  }
  return value.trim();
}
