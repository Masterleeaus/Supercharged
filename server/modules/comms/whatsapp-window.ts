// WhatsApp customer-service window rules.
//
// A business may send free-form text only while the contact's last inbound message
// is within the window (24 hours by default). Outside it, only an approved template
// can be sent. This module is pure: no I/O, no clock reads, no database.

export type WindowTime = Date | number;

export type FreeFormDecision =
  | { freeForm: true }
  | { freeForm: false; reason: 'window_closed' | 'no_inbound' | 'clock_skew' };

export type WhatsAppSendDecision =
  | { send: 'free_form' }
  | { send: 'template' }
  | { send: 'refuse'; reason: 'template_required' | 'clock_skew' };

export interface FreeFormInput {
  lastInboundAt: WindowTime | null | undefined;
  now: WindowTime;
  windowHours?: number;
}

export interface WhatsAppSendInput {
  lastInboundAt: WindowTime | null | undefined;
  now: WindowTime;
  templateApproved: boolean;
  body: string;
  windowHours?: number;
}

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_WINDOW_HOURS = 24;

function toMs(value: WindowTime, label: string): number {
  const ms = value instanceof Date ? value.getTime() : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError(`${label} must be a valid Date or epoch milliseconds`);
  }
  return ms;
}

function windowMs(windowHours: number | undefined): number {
  const hours = windowHours === undefined ? DEFAULT_WINDOW_HOURS : windowHours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
    throw new TypeError('windowHours must be a positive number');
  }
  return hours * HOUR_MS;
}

// Shared classification. Returns the freeForm decision, including the clock_skew case.
function classify(input: FreeFormInput): FreeFormDecision {
  const span = windowMs(input.windowHours);
  const now = toMs(input.now, 'now');
  if (input.lastInboundAt === null || input.lastInboundAt === undefined) {
    return { freeForm: false, reason: 'no_inbound' };
  }
  const inbound = toMs(input.lastInboundAt, 'lastInboundAt');
  if (inbound > now) {
    return { freeForm: false, reason: 'clock_skew' };
  }
  // Strictly less than the window: a message exactly 24 hours old is already closed.
  if (now - inbound < span) {
    return { freeForm: true };
  }
  return { freeForm: false, reason: 'window_closed' };
}

export function canSendFreeForm(input: FreeFormInput): FreeFormDecision {
  return classify(input);
}

// Decide how a WhatsApp message may be sent. `body` is accepted for the caller's
// convenience but does not change the decision: the window rule depends only on time.
export function decideWhatsAppSend(input: WhatsAppSendInput): WhatsAppSendDecision {
  const decision = classify(input);
  if (decision.freeForm) {
    return { send: 'free_form' };
  }
  if (decision.reason === 'clock_skew') {
    return { send: 'refuse', reason: 'clock_skew' };
  }
  if (input.templateApproved === true) {
    return { send: 'template' };
  }
  return { send: 'refuse', reason: 'template_required' };
}
