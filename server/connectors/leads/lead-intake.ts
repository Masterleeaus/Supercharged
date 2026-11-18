/**
 * Lead intake for lead-source connectors (#358). Turns an enquiry from a source (a website form
 * or the chat widget) into one canonical lead with source attribution, and finds the same
 * customer across sources by a dedupe key.
 *
 * Pure: no network, database or environment access. Storage and the follow-up flow belong to the
 * caller.
 *
 * The SDK has no "lead" entity. Leads are carried as the `contact` entity (see decisions in the PR).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConnectorDefinition } from '../sdk/contract.ts';

export const LEAD_SOURCES = ['web_form', 'widget'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export interface CanonicalLead {
  source: LeadSource;
  /** Source-side id for the enquiry, when the source sent one. Used to stop a replay creating two leads. */
  sourceRef?: string;
  name: string;
  email?: string;
  phone?: string;
  message: string;
  receivedAt: string;
}

export type LeadProblem = { path: string; message: string };
export type LeadResult = { ok: true; lead: CanonicalLead } | { ok: false; errors: LeadProblem[] };

const MAX_NAME = 120;
const MAX_MESSAGE = 4_000;
const MAX_REF = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REF_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Australian and general phone normalisation for dedupe only. Keeps digits; "+61 4xx" and "04xx"
 * map to the same national form. Returns undefined when too short to identify anyone.
 */
export function normalizePhone(raw: string): string | undefined {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0061')) digits = digits.slice(4);
  else if (digits.startsWith('61') && digits.length >= 11) digits = `0${digits.slice(2)}`;
  return digits.length >= 8 ? digits : undefined;
}

/** Validates and canonicalises one enquiry. Returns every problem found. */
export function normalizeLead(source: unknown, raw: unknown, receivedAt: Date): LeadResult {
  const errors: LeadProblem[] = [];
  if (!(LEAD_SOURCES as readonly unknown[]).includes(source)) errors.push({ path: 'source', message: 'unknown lead source' });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [...errors, { path: '(body)', message: 'enquiry must be an object' }] };
  }
  const body = raw as Record<string, unknown>;

  const name = text(body.name);
  if (!name) errors.push({ path: 'name', message: 'name is required' });
  else if (name.length > MAX_NAME) errors.push({ path: 'name', message: `name must be ${MAX_NAME} characters or fewer` });

  const email = text(body.email);
  if (email !== undefined && (email.length > 254 || !EMAIL_PATTERN.test(email))) {
    errors.push({ path: 'email', message: 'email is not valid' });
  }
  const phoneRaw = text(body.phone);
  const phone = phoneRaw === undefined ? undefined : normalizePhone(phoneRaw);
  if (phoneRaw !== undefined && phone === undefined) errors.push({ path: 'phone', message: 'phone is not valid' });
  if (email === undefined && phone === undefined) errors.push({ path: 'email', message: 'email or phone is required' });

  const message = text(body.message) ?? '';
  if (message.length > MAX_MESSAGE) errors.push({ path: 'message', message: `message must be ${MAX_MESSAGE} characters or fewer` });

  const ref = text(body.sourceRef);
  if (ref !== undefined && (ref.length > MAX_REF || !REF_PATTERN.test(ref))) {
    errors.push({ path: 'sourceRef', message: 'sourceRef has invalid characters' });
  }

  if (errors.length > 0 || !name || source === undefined) return { ok: false, errors };
  const lead: CanonicalLead = {
    source: source as LeadSource,
    name,
    message,
    receivedAt: receivedAt.toISOString(),
  };
  if (ref !== undefined) lead.sourceRef = ref;
  if (email !== undefined) lead.email = email.toLowerCase();
  if (phone !== undefined) lead.phone = phone;
  return { ok: true, lead };
}

/** The key two enquiries share when they come from the same customer. Email wins over phone. */
export function dedupeKey(lead: Pick<CanonicalLead, 'email' | 'phone'>): string | undefined {
  if (lead.email) return `email:${lead.email.toLowerCase()}`;
  if (lead.phone) return `phone:${lead.phone}`;
  return undefined;
}

/** Finds an existing lead for the same customer, so the caller attaches the new source to it. */
export function findSameCustomer<T extends { email?: string; phone?: string }>(lead: CanonicalLead, candidates: T[]): T | undefined {
  const key = dedupeKey(lead);
  if (!key) return undefined;
  return candidates.find((c) => dedupeKey(c) === key);
}

/**
 * Web form connector definition. Inbound only: the form posts a body signed with HMAC-SHA256 over
 * the raw body. No vendor calls, so there are no actions and auth is "none".
 */
export function createWebFormConnector(): ConnectorDefinition {
  return {
    id: 'web-form',
    auth: 'none',
    capabilities: ['webhook_in'],
    entities: ['contact'],
    actions: {},
    async execute() {
      throw new Error('web-form has no outbound actions');
    },
    verifyWebhook(rawBody: string, signature: string, secret: string): boolean {
      if (typeof secret !== 'string' || secret.length < 32) return false;
      if (!/^[0-9a-f]{64}$/.test(signature)) return false;
      const expected = createHmac('sha256', secret).update(rawBody).digest();
      return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
    },
  };
}
