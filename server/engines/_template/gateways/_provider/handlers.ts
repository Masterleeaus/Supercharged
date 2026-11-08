/**
 * __PROVIDER_PASCAL__ webhook handling.
 *
 * Fixed order: verify signature (fail closed), parse, dispatch, audit.
 * Nothing is parsed or dispatched before the signature check passes.
 */

import type { WebhookRequest, WebhookResult } from '../../types';
import { PROVIDER_ID } from '../../config';
import { verifyWebhookSignature } from '../../webhook-helper';
import { auditEngineEvent } from '../../audit';

export async function handleProviderWebhook(
  req: WebhookRequest,
  secret: string | null
): Promise<WebhookResult> {
  const signature = verifyWebhookSignature({ rawBody: req.rawBody, headers: req.headers, secret });
  if (!signature.valid) {
    await auditEngineEvent({
      action: 'security.unauthorized_access',
      provider: PROVIDER_ID,
      severity: 'warning',
      metadata: { event: 'webhook_rejected', reason: signature.reason },
    });
    return { accepted: false, error: 'invalid_signature' };
  }

  let payload: { type?: unknown; id?: unknown };
  try {
    payload = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    return { accepted: false, error: 'invalid_json' };
  }

  const eventType = typeof payload.type === 'string' ? payload.type : 'unknown';
  return dispatchProviderEvent(eventType, payload);
}

/**
 * Map provider event types to engine actions here. Unknown types are not processed.
 * Add an audit call for each handled event, using an existing AuditAction.
 */
async function dispatchProviderEvent(eventType: string, _payload: unknown): Promise<WebhookResult> {
  return { accepted: false, eventType, error: 'unsupported_event' };
}
