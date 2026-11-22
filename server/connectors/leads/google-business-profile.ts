/**
 * Google Business Profile lead source (#358).
 *
 * Reads messages (enquiries) and reviews for one business location through an injected client. Each
 * message becomes one canonical lead with source attribution and a sourceRef, so a repeated poll does not
 * create a second lead. Reviews are read only: they are returned to the caller and never answered here.
 *
 * Replies are write actions. They are sent only with an explicit approval that names the same target and
 * the same text. Without it, nothing is posted. The client is injected, so this module makes no network call
 * by itself. A live client needs a real Google account and per-location authorisation, which this module does
 * not provide.
 */
import { normalizeLead, type CanonicalLead } from './lead-intake.ts';

export interface GbpMessage {
  id: string;
  senderName: string;
  senderEmail?: string;
  senderPhone?: string;
  text: string;
  createdAt: string;
}

export interface GbpReview {
  id: string;
  reviewerName: string;
  rating: number;
  comment: string;
  createdAt: string;
}

export type GbpReplyTarget = { kind: 'message' | 'review'; id: string };

export interface GbpClient {
  listMessages(locationId: string, sinceIso: string): Promise<GbpMessage[]>;
  listReviews(locationId: string, sinceIso: string): Promise<GbpReview[]>;
  postReply(locationId: string, target: GbpReplyTarget, text: string): Promise<{ id: string }>;
}

export type GbpPollResult =
  | { ok: true; leads: CanonicalLead[]; rejected: number; reviews: GbpReview[] }
  | { ok: false; reason: 'provider_error'; message: string };

/** Reads new enquiries and reviews for a location. Never posts anything. */
export async function pollGoogleBusinessProfile(
  input: { locationId: string; sinceIso: string; receivedAt: Date },
  deps: { client: GbpClient },
): Promise<GbpPollResult> {
  let messages: GbpMessage[];
  let reviews: GbpReview[];
  try {
    [messages, reviews] = await Promise.all([
      deps.client.listMessages(input.locationId, input.sinceIso),
      deps.client.listReviews(input.locationId, input.sinceIso),
    ]);
  } catch (err) {
    return { ok: false, reason: 'provider_error', message: err instanceof Error ? err.message : 'unknown provider error' };
  }

  const leads: CanonicalLead[] = [];
  let rejected = 0;
  for (const message of messages) {
    const result = normalizeLead(
      'google_business_profile',
      {
        name: message.senderName,
        email: message.senderEmail,
        phone: message.senderPhone,
        message: message.text,
        sourceRef: `gbp:${message.id}`,
      },
      input.receivedAt,
    );
    if (result.ok) leads.push(result.lead);
    else rejected += 1;
  }
  return { ok: true, leads, rejected, reviews };
}

export interface GbpReplyApproval {
  approvedBy: string;
  approvedAt: string;
  target: GbpReplyTarget;
  text: string;
}

export type GbpReplyResult =
  | { ok: true; replyId: string }
  | { ok: false; reason: 'approval_missing' | 'approval_mismatch' | 'provider_error'; message?: string };

/** Posts one reply, and only when the approval names the same target and the same text. */
export async function sendApprovedGbpReply(
  input: { locationId: string; target: GbpReplyTarget; text: string; approval: GbpReplyApproval | null | undefined },
  deps: { client: GbpClient },
): Promise<GbpReplyResult> {
  const approval = input.approval;
  if (!approval || typeof approval.approvedBy !== 'string' || approval.approvedBy.trim() === '') {
    return { ok: false, reason: 'approval_missing' };
  }
  const sameTarget = approval.target.kind === input.target.kind && approval.target.id === input.target.id;
  if (!sameTarget || approval.text !== input.text) return { ok: false, reason: 'approval_mismatch' };
  try {
    const posted = await deps.client.postReply(input.locationId, input.target, input.text);
    return { ok: true, replyId: posted.id };
  } catch (err) {
    return { ok: false, reason: 'provider_error', message: err instanceof Error ? err.message : 'unknown provider error' };
  }
}
