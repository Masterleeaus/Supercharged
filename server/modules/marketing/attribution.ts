// Resolves a tracking-link click to a campaign and source, scoped to one company. Fail closed.
// The company is supplied by the caller from its verified context, never read from the URL.
// The click is accepted only when the tid recomputes for that company and the campaign exists
// in that company. Any missing company, malformed link, token mismatch or lookup error is a refusal.
// The tid is not a secret: this check guards analytics attribution, not access to data.
import { computeTrackingToken, isValidCampaignId, isValidChannel, isValidSource, parseTrackingLink } from './tracking-links.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Answers "does this campaign exist in this company". Same contract as the marketing CampaignRefs port. */
export interface AttributionCampaignRefs {
  campaignExists(companyId: string, campaignId: string): Promise<boolean>;
}

export type ClickAttributionFailure =
  | 'missing_company'
  | 'invalid_company'
  | 'not_tracking_link'
  | 'invalid_fields'
  | 'token_mismatch'
  | 'unknown_campaign'
  | 'lookup_failed';

export type ClickAttributionResult =
  | { ok: true; companyId: string; campaignId: string; channel: string; source: string; tid: string }
  | { ok: false; reason: ClickAttributionFailure };

export async function attributeClick(
  input: { companyId: unknown; url: unknown },
  refs: AttributionCampaignRefs,
): Promise<ClickAttributionResult> {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'missing_company' };
  const { companyId, url } = input;

  if (companyId === undefined || companyId === null || companyId === '') {
    return { ok: false, reason: 'missing_company' };
  }
  if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) {
    return { ok: false, reason: 'invalid_company' };
  }

  if (typeof url !== 'string') return { ok: false, reason: 'not_tracking_link' };
  const parsed = parseTrackingLink(url);
  if (!parsed.ok) return { ok: false, reason: 'not_tracking_link' };

  const { campaign, medium, source, tid } = parsed;
  if (!isValidCampaignId(campaign) || !isValidChannel(medium) || !isValidSource(source)) {
    return { ok: false, reason: 'invalid_fields' };
  }

  // The token covers the company, so a link minted for another company fails here.
  if (computeTrackingToken(companyId, campaign, medium, source) !== tid) {
    return { ok: false, reason: 'token_mismatch' };
  }

  let exists: boolean;
  try {
    exists = await refs.campaignExists(companyId, campaign);
  } catch {
    return { ok: false, reason: 'lookup_failed' };
  }
  if (exists !== true) return { ok: false, reason: 'unknown_campaign' };

  return { ok: true, companyId, campaignId: campaign, channel: medium, source, tid };
}
