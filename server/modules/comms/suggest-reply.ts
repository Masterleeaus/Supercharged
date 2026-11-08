// Suggested reply for an inbox thread. Until a model is connected, the suggestion is the best matching
// saved reply for the company. The owner can edit it before it is sent. Pure function: no storage, no network.
//
// Autonomy: a suggestion is Suggest-tier output. It never sends. Every send, bulk campaign, contact export,
// account change, money movement and record delete goes through gateCommsAction below, which uses the
// authority ladder (server/modules/approvals/authority-ladder.ts).

import { evaluateAuthority, type AutonomyLevel, type HumanActor, type RiskTier } from '../approvals/authority-ladder.ts';
import { checkConsent, type Channel, type Contact, type DateInput, type QuietHours } from './consent.ts';
import { isValidCompanyId, type SavedReply, type SavedReplyChannel } from './saved-replies.ts';
import { canSendFreeForm, type WindowTime } from './whatsapp-window.ts';

export interface SuggestReplyThread {
  /** Thread id in the inbox. Required: every suggestion must point at its source records. */
  threadId: string;
  /** Id of the inbound message whose text was matched. Required for the same reason. */
  inboundMessageId: string;
  channel: SavedReplyChannel;
  lastInboundText: string;
  topicKeywords?: string[];
}

export interface SuggestReplyInput {
  companyId: string;
  thread: SuggestReplyThread;
  savedReplies: readonly SavedReply[];
}

export interface SuggestReplySources {
  savedReplyId: string;
  threadId: string;
  inboundMessageId: string;
}

export type SuggestReplyResult =
  | {
      ok: true;
      /** Always 'suggest'. Suggestions are Suggest-tier output. */
      tier: 'suggest';
      /** Always false. A suggestion is never sent by this module. */
      sends: false;
      replyId: string;
      title: string;
      body: string;
      reason: string;
      /** Every record this suggestion was built from. Shown to the owner as evidence. */
      sources: SuggestReplySources;
    }
  | { ok: false; reason: 'no_match' | 'invalid_company' | 'missing_source' };

const STOP_WORDS: ReadonlySet<string> = new Set([
  'about', 'above', 'after', 'again', 'against', 'all', 'also', 'and', 'any', 'are', 'because', 'been', 'before',
  'being', 'below', 'between', 'both', 'but', 'can', 'could', 'did', 'does', 'doing', 'done', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'her', 'here', 'hers', 'him', 'his',
  'how', 'into', 'its', 'just', 'more', 'most', 'much', 'must', 'myself', 'nor', 'not', 'now', 'off', 'once',
  'only', 'other', 'otherwise', 'our', 'ours', 'out', 'over', 'own', 'same', 'shall', 'she', 'should', 'some',
  'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'too', 'under', 'until', 'very', 'was', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
]);

/**
 * Lowercases text, removes punctuation and digits (anything that is not a letter), splits into words,
 * and keeps only words of at least 3 letters that are not stop words.
 */
function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    words.add(raw);
  }
  return words;
}

function createdAtMs(reply: SavedReply): number {
  const ms = Date.parse(reply.createdAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Picks the saved reply that best matches the inbound text for the thread's channel.
 * Score = distinct content words shared with lastInboundText + distinct topicKeywords the reply contains.
 * Highest score wins; ties go to the earlier-created reply. A zero score is no_match.
 */
export function suggestReply(input: SuggestReplyInput): SuggestReplyResult {
  const { companyId, thread, savedReplies } = input;
  if (!isValidCompanyId(companyId)) return { ok: false, reason: 'invalid_company' };
  if (!thread || typeof thread !== 'object') return { ok: false, reason: 'no_match' };
  // Fail closed: a suggestion without its source records is not shown.
  if (!isNonEmptyId(thread.threadId) || !isNonEmptyId(thread.inboundMessageId)) {
    return { ok: false, reason: 'missing_source' };
  }

  const inbound = contentWords(typeof thread.lastInboundText === 'string' ? thread.lastInboundText : '');
  const keywords = [...new Set((thread.topicKeywords ?? []).flatMap((k) => [...contentWords(String(k))]))];

  let best: { reply: SavedReply; score: number; shared: number; topics: number; at: number } | null = null;

  for (const reply of savedReplies) {
    if (reply.companyId !== companyId) continue;
    if (reply.channel !== thread.channel && reply.channel !== 'any') continue;

    const replyWords = contentWords(`${reply.title} ${reply.body}`);
    let shared = 0;
    for (const word of inbound) if (replyWords.has(word)) shared += 1;
    let topics = 0;
    for (const keyword of keywords) if (replyWords.has(keyword)) topics += 1;

    const score = shared + topics;
    if (score === 0) continue;

    const at = createdAtMs(reply);
    if (best === null || score > best.score || (score === best.score && at < best.at)) {
      best = { reply, score, shared, topics, at };
    }
  }

  if (best === null) return { ok: false, reason: 'no_match' };

  const reason = `matched ${best.shared} shared word${best.shared === 1 ? '' : 's'} and ${best.topics} topic keyword${best.topics === 1 ? '' : 's'}`;
  return {
    ok: true,
    tier: 'suggest',
    sends: false,
    replyId: best.reply.id,
    title: best.reply.title,
    body: best.reply.body,
    reason,
    sources: {
      savedReplyId: best.reply.id,
      threadId: thread.threadId,
      inboundMessageId: thread.inboundMessageId,
    },
  };
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200;
}

// ---------------------------------------------------------------------------------------------
// Tier gate for comms actions.
// ---------------------------------------------------------------------------------------------

/** Actions that change data or reach a customer. All are treated as writes (fail closed). */
export const COMMS_ACTIONS = [
  'customer_send',
  'bulk_campaign',
  'contact_export',
  'account_change',
  'money_movement',
  'record_delete',
] as const;
export type CommsAction = (typeof COMMS_ACTIONS)[number];

/**
 * Risk per action. The authority ladder cannot see an action's category, so the caller assigns it here.
 * Customer sends, money and deletes are critical: never allowed unattended, always approval-gated.
 */
export const COMMS_ACTION_RISK: Readonly<Record<CommsAction, RiskTier>> = {
  customer_send: 'critical',
  money_movement: 'critical',
  record_delete: 'critical',
  bulk_campaign: 'high',
  contact_export: 'high',
  account_change: 'high',
};

/**
 * Recipient facts a customer_send needs. The caller reads them from the same stores a staff send uses.
 * Required for customer_send: a missing field refuses the send.
 */
export interface CustomerSendContext {
  /** Channel the message would go out on. */
  channel: unknown;
  /** The recipient's contact record, with consent events and handles. */
  contact: unknown;
  /** Current time, used for quiet hours and the messaging window. */
  now: unknown;
  /** Result of the company suppression list for this recipient address. Must be a boolean. */
  suppressed: unknown;
  quietHours?: unknown;
  timezone?: unknown;
  /** Last inbound message time, used for the messaging window on windowed channels. */
  lastInboundAt?: unknown;
}

export interface CommsGateInput {
  companyId: unknown;
  action: unknown;
  /** Acting autonomy tier, or HUMAN_ACTOR for a verified human. Anything else fails closed. */
  autonomy: unknown;
  /** True only when an owner approval has been verified for this exact action. */
  humanApproved?: unknown;
  /** True only when the actor is a verified human. */
  actorIsHuman?: unknown;
  /** Required for customer_send. Checked before the ladder, so no approval can override a refusal. */
  outbound?: unknown;
}

export interface CommsGateResult {
  decision: 'allow' | 'require_approval' | 'deny';
  reason: string;
  action: CommsAction | null;
  risk: RiskTier | null;
  autonomy: AutonomyLevel | HumanActor | null;
}

// Channels whose free-form messages are limited to a window after the contact's last inbound message.
const WINDOWED_CHANNELS: ReadonlySet<string> = new Set(['whatsapp', 'messenger', 'instagram']);

/**
 * Same recipient checks a staff send gets from the provider adapters: suppression list, contact consent
 * (opt-out, channel opt-in, quiet hours) and the messaging window. Returns a refusal reason, or null to pass.
 * Never throws. Missing or malformed input refuses.
 */
function customerSendRefusal(outbound: unknown): string | null {
  if (!outbound || typeof outbound !== 'object') return 'customer send has no recipient context; failing closed';
  const o = outbound as CustomerSendContext;
  if (typeof o.suppressed !== 'boolean') return 'suppression state missing; failing closed';
  if (o.suppressed) return 'recipient is on the suppression list';
  if (typeof o.channel !== 'string') return 'channel missing; failing closed';
  try {
    const consent = checkConsent({
      channel: o.channel as Channel,
      contact: o.contact as Contact | null | undefined,
      now: o.now as DateInput,
      quietHours: o.quietHours as QuietHours | null | undefined,
      timezone: typeof o.timezone === 'string' ? o.timezone : undefined,
    });
    if (!consent.allowed) return `recipient consent refused: ${consent.reason}`;
    if (WINDOWED_CHANNELS.has(o.channel)) {
      const window = canSendFreeForm({
        lastInboundAt: o.lastInboundAt as WindowTime | null | undefined,
        now: o.now as WindowTime,
      });
      if (!window.freeForm) return `messaging window closed: ${window.reason}`;
    }
    return null;
  } catch {
    return 'recipient check failed; failing closed';
  }
}

/**
 * Decide whether a comms action may run now. Refuses Assist and Suggest for every write (all comms actions),
 * requires a verified owner approval for customer sends, money and deletes, and refuses anything it cannot
 * read. A customer_send is refused first when the recipient fails suppression, consent, quiet hours or the
 * messaging window, so an approval cannot override those. Never throws. The caller must run the action only on 'allow'.
 */
export function gateCommsAction(input: CommsGateInput): CommsGateResult {
  if (!input || typeof input !== 'object') {
    return { decision: 'deny', reason: 'missing gate input; failing closed', action: null, risk: null, autonomy: null };
  }
  if (!isValidCompanyId(input.companyId)) {
    return { decision: 'deny', reason: 'company is missing or invalid; failing closed', action: null, risk: null, autonomy: null };
  }
  const action = typeof input.action === 'string' && (COMMS_ACTIONS as readonly string[]).includes(input.action)
    ? (input.action as CommsAction)
    : null;
  if (action === null) {
    return { decision: 'deny', reason: 'unknown comms action; failing closed', action: null, risk: null, autonomy: null };
  }
  const risk = COMMS_ACTION_RISK[action];

  if (action === 'customer_send') {
    const refusal = customerSendRefusal(input.outbound);
    if (refusal !== null) {
      return { decision: 'deny', reason: refusal, action, risk, autonomy: null };
    }
  }

  const ladder = evaluateAuthority({
    tier: risk,
    autonomy: input.autonomy,
    humanApproved: input.humanApproved,
    actorIsHuman: input.actorIsHuman,
    access: 'write',
  });

  return { decision: ladder.decision, reason: ladder.reason, action, risk, autonomy: ladder.autonomy };
}
