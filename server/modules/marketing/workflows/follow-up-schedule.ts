// Editable follow-up schedules for quotes, unpaid invoices and new leads (#361). Adapted from the
// donor workers estimate-followup, expire-estimates, invoice-followup and lead-followup.
//
// A schedule is data. Each company can override any kind in admin. Overrides are validated here
// before they are stored, so a bad schedule is rejected instead of silently sending at odd times.
// Times are hours from the anchor: sent_at for a quote, due date for an invoice, created_at for a lead.

export const FOLLOW_UP_KINDS = ['quote', 'invoice', 'lead'] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

/**
 * 'reminder' is a neutral nudge. 'payment_demand' asks for money and needs a person's approval
 * before it can be sent, every time.
 */
export const STEP_KINDS = ['reminder', 'payment_demand'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface FollowUpStep {
  /** Hours after the anchor. Steps must rise strictly. */
  afterHours: number;
  kind: StepKind;
}

export interface FollowUpSchedule {
  kind: FollowUpKind;
  steps: FollowUpStep[];
  /** Once this many messages have gone out with no answer, a person is asked to take over. 1 to 10. */
  escalateAfterAttempts: number;
  /** Quotes only: hours after the anchor when the quote expires. Null means it never expires. */
  expireAfterHours: number | null;
}

const MAX_STEPS = 10;
const MAX_HOURS = 24 * 365;

export const DEFAULT_SCHEDULES: Record<FollowUpKind, FollowUpSchedule> = {
  quote: {
    kind: 'quote',
    steps: [
      { afterHours: 3 * 24, kind: 'reminder' },
      { afterHours: 7 * 24, kind: 'reminder' },
      { afterHours: 14 * 24, kind: 'reminder' },
    ],
    escalateAfterAttempts: 3,
    expireAfterHours: 30 * 24,
  },
  invoice: {
    kind: 'invoice',
    steps: [
      { afterHours: 7 * 24, kind: 'reminder' },
      { afterHours: 14 * 24, kind: 'reminder' },
      { afterHours: 30 * 24, kind: 'payment_demand' },
    ],
    escalateAfterAttempts: 3,
    expireAfterHours: null,
  },
  lead: {
    kind: 'lead',
    steps: [
      { afterHours: 2, kind: 'reminder' },
      { afterHours: 24, kind: 'reminder' },
    ],
    escalateAfterAttempts: 2,
    expireAfterHours: null,
  },
};

export type ScheduleParseResult =
  | { ok: true; schedule: FollowUpSchedule }
  | { ok: false; errors: string[] };

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validates a company's override for one kind and fills the rest from the default.
 * Returns every error found, not just the first.
 */
export function parseSchedule(kind: FollowUpKind, raw: unknown): ScheduleParseResult {
  if (!(FOLLOW_UP_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, errors: ['kind is not a follow-up kind'] };
  }
  const base = DEFAULT_SCHEDULES[kind];
  if (raw === undefined || raw === null) return { ok: true, schedule: structuredClone(base) };
  if (typeof raw !== 'object') return { ok: false, errors: ['schedule must be an object'] };
  const input = raw as Record<string, unknown>;
  const errors: string[] = [];

  const steps = input.steps ?? base.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) {
    errors.push(`steps must be a list of 1 to ${MAX_STEPS} items`);
  } else {
    let previous = 0;
    steps.forEach((step, i) => {
      const s = step as Partial<FollowUpStep> | null;
      if (!s || !isInt(s.afterHours, 1, MAX_HOURS)) {
        errors.push(`steps[${i}].afterHours must be a whole number of hours from 1 to ${MAX_HOURS}`);
        return;
      }
      if (!(STEP_KINDS as readonly string[]).includes(s.kind as string)) {
        errors.push(`steps[${i}].kind must be reminder or payment_demand`);
      }
      if (s.afterHours <= previous) errors.push(`steps[${i}].afterHours must be later than the step before`);
      if (kind === 'lead' && s.kind === 'payment_demand') errors.push('a lead cannot receive a payment demand');
      previous = s.afterHours;
    });
  }

  const escalateAfterAttempts = input.escalateAfterAttempts ?? base.escalateAfterAttempts;
  if (!isInt(escalateAfterAttempts, 1, MAX_STEPS)) {
    errors.push(`escalateAfterAttempts must be a whole number from 1 to ${MAX_STEPS}`);
  }

  let expireAfterHours = input.expireAfterHours === undefined ? base.expireAfterHours : input.expireAfterHours;
  if (kind !== 'quote' && expireAfterHours !== null) {
    errors.push('only quotes can expire');
  } else if (expireAfterHours !== null && !isInt(expireAfterHours, 1, MAX_HOURS)) {
    errors.push(`expireAfterHours must be null or a whole number of hours from 1 to ${MAX_HOURS}`);
  }
  if (expireAfterHours === undefined) expireAfterHours = null;

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    schedule: {
      kind,
      steps: (steps as FollowUpStep[]).map((s) => ({ afterHours: s.afterHours, kind: s.kind })),
      escalateAfterAttempts: escalateAfterAttempts as number,
      expireAfterHours: expireAfterHours as number | null,
    },
  };
}
