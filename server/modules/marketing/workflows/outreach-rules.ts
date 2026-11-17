// Eligibility rules for the client outreach workflows (#360). Adapted from the donor workers
// review-request, client-reactivation, seasonal-reminder, visit-reminder and stale-job-nudge.
// The donor SQL and its own mailer are not used. Each rule is a pure function of the record
// and `now`. Whether a message may actually go out is decided later by gatedSend.
//
// Day arithmetic is in whole UTC days. A company-timezone version belongs with the store adapter.

export const OUTREACH_WORKFLOWS = [
  'review_request',
  'client_reactivation',
  'seasonal_reminder',
  'visit_reminder',
  'stale_job_nudge',
] as const;

export type OutreachWorkflow = (typeof OUTREACH_WORKFLOWS)[number];

/** Visit reminders and stale-job nudges are service messages. Everything else is marketing. */
export const WORKFLOW_SURFACE: Record<OutreachWorkflow, 'inbox' | 'marketing'> = {
  review_request: 'marketing',
  client_reactivation: 'marketing',
  seasonal_reminder: 'marketing',
  visit_reminder: 'inbox',
  stale_job_nudge: 'inbox',
};

export interface ReviewRequestConfig {
  /** Whole days after completion before the request goes out. */
  delayDays: number;
}

export interface ReactivationConfig {
  /** A client with no completed job for this many days is lapsed. */
  inactiveDays: number;
}

export interface SeasonalWindow {
  /** 1 to 12. */
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
}

export interface VisitReminderConfig {
  /** Whole hours before the visit start. */
  leadHours: number;
}

export interface StaleJobConfig {
  /** Days with no activity and no future visit before the nudge. */
  inactiveDays: number;
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new RangeError(`${name} must be a whole number from 1 to 3650`);
  }
}

function toDate(value: Date | string | number): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) throw new RangeError('invalid date');
  return d;
}

/** Whole UTC days from `from` to `to`. Negative when `to` is earlier. */
export function wholeDaysBetween(from: Date | string | number, to: Date | string | number): number {
  const a = toDate(from);
  const b = toDate(to);
  const utcMidnight = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((utcMidnight(b) - utcMidnight(a)) / 86_400_000);
}

export function reviewRequestDue(input: {
  completedAt: Date | string | number | null;
  now: Date | string | number;
  config: ReviewRequestConfig;
}): boolean {
  assertPositiveInt('delayDays', input.config.delayDays);
  if (input.completedAt === null) return false;
  return wholeDaysBetween(input.completedAt, input.now) >= input.config.delayDays;
}

export function reactivationDue(input: {
  lastCompletedJobAt: Date | string | number | null;
  now: Date | string | number;
  config: ReactivationConfig;
}): boolean {
  assertPositiveInt('inactiveDays', input.config.inactiveDays);
  // A client who has never completed a job is a lead, not a lapsed client.
  if (input.lastCompletedJobAt === null) return false;
  return wholeDaysBetween(input.lastCompletedJobAt, input.now) >= input.config.inactiveDays;
}

function inSeasonalWindow(month: number, day: number, w: SeasonalWindow): boolean {
  const value = month * 100 + day;
  const start = w.startMonth * 100 + w.startDay;
  const end = w.endMonth * 100 + w.endDay;
  // A window may cross the year end (for example 20 Dec to 10 Jan).
  return start <= end ? value >= start && value <= end : value >= start || value <= end;
}

/**
 * Returns the cycle key for a seasonal campaign when `now` is inside its window, otherwise null.
 * The key is the season's start year, so each season is sent once per client, even when the
 * window crosses the new year.
 */
export function seasonalCycleKey(input: { now: Date | string | number; window: SeasonalWindow; name: string }): string | null {
  const d = toDate(input.now);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (!inSeasonalWindow(month, day, input.window)) return null;
  const wraps = input.window.startMonth * 100 + input.window.startDay > input.window.endMonth * 100 + input.window.endDay;
  const seasonYear = wraps && month * 100 + day <= input.window.endMonth * 100 + input.window.endDay
    ? d.getUTCFullYear() - 1
    : d.getUTCFullYear();
  return `${input.name}:${seasonYear}`;
}

export function visitReminderDue(input: {
  visitStartsAt: Date | string | number;
  now: Date | string | number;
  config: VisitReminderConfig;
}): boolean {
  assertPositiveInt('leadHours', input.config.leadHours);
  const start = toDate(input.visitStartsAt).getTime();
  const now = toDate(input.now).getTime();
  const leadMs = input.config.leadHours * 3_600_000;
  // Due inside the lead window only. A visit already in the past is never reminded.
  return now < start && start - now <= leadMs;
}

export function staleJobNudgeDue(input: {
  lastActivityAt: Date | string | number;
  hasFutureVisit: boolean;
  now: Date | string | number;
  config: StaleJobConfig;
}): boolean {
  assertPositiveInt('inactiveDays', input.config.inactiveDays);
  if (input.hasFutureVisit) return false;
  return wholeDaysBetween(input.lastActivityAt, input.now) >= input.config.inactiveDays;
}

// Default copy. Placeholders are {{name}}. A missing placeholder fails the render, so a message
// is never sent with a blank name or link.
export const DEFAULT_TEMPLATES: Record<OutreachWorkflow, { subject: string | null; body: string }> = {
  review_request: {
    subject: 'How did we do?',
    body: 'Hi {{clientName}}, thanks for choosing {{companyName}}. If you have a minute, we would appreciate a review: {{reviewUrl}}',
  },
  client_reactivation: {
    subject: 'Time for your next visit?',
    body: 'Hi {{clientName}}, it has been a while since we last saw you at {{companyName}}. Reply here or book at {{bookingUrl}}.',
  },
  seasonal_reminder: {
    subject: '{{seasonName}} is here',
    body: 'Hi {{clientName}}, {{companyName}} is booking {{seasonName}} work now. Book at {{bookingUrl}}.',
  },
  visit_reminder: {
    subject: 'Your visit is coming up',
    body: 'Hi {{clientName}}, a reminder that {{companyName}} is booked for {{visitTime}}.',
  },
  stale_job_nudge: {
    subject: null,
    body: 'Hi {{clientName}}, your {{jobTitle}} job with {{companyName}} is still open. Reply to book the next step.',
  },
};

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new RangeError(`template variable ${name} is missing`);
    }
    return value;
  });
}
