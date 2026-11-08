/** Desk-native Express adapter. Registered in server/routes.ts, disabled by default.
 * Production ports are deliberately unconfigured until the DB integration agent
 * supplies tenant mapping, consent verification and a durable event ledger.
 */
import { Router, type Request, type Response } from 'express';
// @ts-ignore JS module is intentionally shared with the Field Next.js runtime.
import { receiveCommunicationIntent } from './receiver.mjs';

/** Wire intent as produced by parseCommunicationIntent (protocol.mjs lines 49, 108-113). */
export interface CommunicationIntent {
  schema: 'titan.field-desk.communication-intent.v1';
  event_id: string;
  correlation_id: string;
  company_id: string;
  requested_at: string;
  channel: 'sms' | 'email';
  template_key: string;
  recipient: {kind: 'field_client'; reference: string};
  resource: {kind: 'visit' | 'job' | 'invoice' | 'estimate' | 'booking_request'; reference: string};
  consent: {evidence_reference: string; recorded_at: string};
}

/** Port 1 result, read by receiver.mjs lines 35-37 (active is checked against true, so it is boolean here). */
export interface CompanyMapping {
  company_id: string;
  desk_user_id: string;
  active: boolean;
}

/** Receipt built by receiver.mjs lines 52-59 and returned as the 202 or 200 body. */
export interface CommunicationResultReceipt {
  schema: 'titan.field-desk.communication-result.v1';
  source_event_id: string;
  correlation_id: string;
  company_id: string;
  status: 'simulated';
  delivery_status: 'not_sent';
  reason: 'shadow_mode_no_provider_dispatch';
  occurred_at: string;
}

/** Input to verifyConsent, receiver.mjs line 38. */
export interface VerifyConsentInput {
  intent: CommunicationIntent;
  mapping: CompanyMapping;
}

/** Input to claimEvent, receiver.mjs lines 42-43. */
export interface ClaimEventInput {
  companyId: string;
  eventId: string;
  correlationId: string;
  payloadHash: string;
  intent: CommunicationIntent;
  deskUserId: string;
}

/** Input to recordResult, receiver.mjs line 60. */
export interface RecordResultInput {
  intent: CommunicationIntent;
  mapping: CompanyMapping;
  receipt: CommunicationResultReceipt;
}

/**
 * Port 3 result, handled by receiver.mjs lines 44-51. Any other state, or a missing state,
 * yields 503 ledger_unavailable. A duplicate without a matching payloadHash and receipt is 409.
 */
export type ClaimEventResult =
  | {state: 'claimed'}
  | {state: 'duplicate'; payloadHash?: string; receipt?: CommunicationResultReceipt}
  | {state: 'conflict'}
  | {state: 'unavailable'};

export interface TitanBridgePorts {
  resolveCompany(companyId: string): Promise<CompanyMapping | null>;
  verifyConsent(input: VerifyConsentInput): Promise<boolean>;
  claimEvent(input: ClaimEventInput): Promise<ClaimEventResult>;
  recordResult(input: RecordResultInput): Promise<void>;
}

export function createTitanFieldBridgeRouter(ports?: TitanBridgePorts): Router {
  const router = Router();
  router.post('/api/titan-bridge/v1/communication-intents', async (req: Request, res: Response) => {
    // Safe even if accidentally deployed: no provider delivery is supported.
    if (process.env.TITAN_FIELD_BRIDGE_MODE !== 'shadow') {
      res.status(503).json({error: 'bridge_not_enabled'});
      return;
    }
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : undefined;
    const answer = await receiveCommunicationIntent({body: rawBody, headers: req.headers}, {
      secret: process.env.TITAN_FIELD_BRIDGE_SECRET,
      ports
    });
    res.status(answer.status).set('cache-control', 'no-store').json(answer.body);
  });
  return router;
}
