// Campaign link rewriting. At send time every https link in a campaign message gets campaign and
// source tracking through buildTrackingLink. Pure functions: no I/O, no clock, no randomness.
//
// Fail closed: a bad campaign context refuses the text even when it has no links. A link that
// fails the check refuses the whole text. Reasons are generic and never include a URL.
import { buildTrackingLink } from '../marketing/tracking-links.ts';

export type CampaignLinkContext = {
  companyId: string;
  campaignId: string;
  channel: string;
  /** Optional. Defaults to the channel, as buildTrackingLink does. */
  source?: string;
};

export type RewriteCampaignLinksInput = {
  text: string;
  baseContext: CampaignLinkContext;
};

export type RewriteCampaignLinksResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'unsafe_link' | 'invalid_input' };

// Conservative: an http or https scheme, then any run of characters that is not whitespace, a
// quote, a backtick or an angle bracket. Case-insensitive, since URL schemes are.
const LINK_RE = /https?:\/\/[^\s<>"'`]+/gi;
const HTTPS_RE = /^https:\/\//i;
// Used only to validate the campaign context through the same rules as the real builder.
const PROBE_BASE_URL = 'https://links.invalid/';
const TRAILING_PUNCTUATION = '.,;:!?';
const CLOSING_TO_OPENING: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Splits sentence punctuation off the end of a matched link. A closing bracket stays only when
 * the link itself opens one it balances, so "(see https://x.test/a)" keeps the ")" outside the link.
 */
function splitTrailing(match: string): { link: string; tail: string } {
  let end = match.length;
  for (;;) {
    const ch = match[end - 1];
    if (ch !== undefined && TRAILING_PUNCTUATION.includes(ch)) {
      end -= 1;
      continue;
    }
    const opening = ch !== undefined ? CLOSING_TO_OPENING[ch] : undefined;
    if (opening !== undefined) {
      const candidate = match.slice(0, end);
      const opens = candidate.split(opening).length - 1;
      const closes = candidate.split(ch as string).length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return { link: match.slice(0, end), tail: match.slice(end) };
}

export function rewriteCampaignLinks(input: RewriteCampaignLinksInput): RewriteCampaignLinksResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid_input' };
  const { text, baseContext } = input;
  if (typeof text !== 'string' || !baseContext || typeof baseContext !== 'object') {
    return { ok: false, reason: 'invalid_input' };
  }
  const { companyId, campaignId, channel, source } = baseContext;

  // Validate the context once, up front, so a missing company is refused even if there are no links.
  const probe = buildTrackingLink({ baseUrl: PROBE_BASE_URL, companyId, campaignId, channel, source });
  if (!probe.ok) return { ok: false, reason: 'invalid_input' };

  const state = { unsafe: false };
  const rewritten = text.replace(LINK_RE, (match) => {
    if (state.unsafe) return match;
    const { link, tail } = splitTrailing(match);
    // Any scheme other than https, including plain http, is refused.
    if (!HTTPS_RE.test(link)) {
      state.unsafe = true;
      return match;
    }
    const built = buildTrackingLink({ baseUrl: link, companyId, campaignId, channel, source });
    if (!built.ok) {
      state.unsafe = true;
      return match;
    }
    return `${built.url}${tail}`;
  });

  if (state.unsafe) return { ok: false, reason: 'unsafe_link' };
  return { ok: true, text: rewritten };
}
