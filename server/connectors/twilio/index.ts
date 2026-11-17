/**
 * Twilio SMS connector on the connector SDK (#357).
 *
 * One write action, sendSms. Credentials arrive per call from the vault as an api_key whose value
 * is "<AccountSid>:<AuthToken>". The connector never logs them, never puts them in a URL and never
 * returns the vendor body: it returns only the message SID and status.
 *
 * Sends are not idempotent at Twilio, so the gated sender (gated-sms.ts) runs this action with a
 * single attempt. A retry after an ambiguous failure could send the SMS twice.
 */
import {
  ConnectorError,
  errorFromStatus,
  type ActionRequest,
  type ConnectorCredentials,
  type ConnectorDefinition,
} from '../sdk/contract.ts';

export const TWILIO_CONNECTOR_ID = 'twilio';
const DEFAULT_BASE_URL = 'https://api.twilio.com';
const E164 = /^\+[1-9]\d{6,14}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const MAX_BODY = 1600;

export interface SendSmsInput {
  to: string;
  body: string;
  from?: string;
  messagingServiceSid?: string;
}

export interface SendSmsResult {
  externalId: string;
  status: string;
}

export interface TwilioConnectorOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function validateSendSmsInput(input: unknown): SendSmsInput {
  if (typeof input !== 'object' || input === null) throw new ConnectorError('validation', 'sendSms input must be an object');
  const { to, body, from, messagingServiceSid } = input as Record<string, unknown>;
  if (typeof to !== 'string' || !E164.test(to)) throw new ConnectorError('validation', 'to must be an E.164 number');
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_BODY) {
    throw new ConnectorError('validation', `body must be 1 to ${MAX_BODY} characters`);
  }
  const hasFrom = typeof from === 'string' && from.length > 0;
  const hasService = typeof messagingServiceSid === 'string' && messagingServiceSid.length > 0;
  if (hasFrom === hasService) throw new ConnectorError('validation', 'name exactly one of from or messagingServiceSid');
  if (hasFrom && !E164.test(from as string)) throw new ConnectorError('validation', 'from must be an E.164 number');
  if (hasService && !MESSAGING_SERVICE_SID.test(messagingServiceSid as string)) {
    throw new ConnectorError('validation', 'messagingServiceSid is malformed');
  }
  return {
    to,
    body,
    ...(hasFrom ? { from: from as string } : { messagingServiceSid: messagingServiceSid as string }),
  };
}

/** Splits the vault value "<AccountSid>:<AuthToken>". Throws auth without echoing the value. */
export function parseTwilioCredentials(credentials: ConnectorCredentials): { accountSid: string; authToken: string } {
  if (credentials.type !== 'api_key') throw new ConnectorError('auth', 'Twilio needs an api_key credential');
  const sep = credentials.apiKey.indexOf(':');
  const accountSid = sep > 0 ? credentials.apiKey.slice(0, sep) : '';
  const authToken = sep > 0 ? credentials.apiKey.slice(sep + 1) : '';
  if (!ACCOUNT_SID.test(accountSid) || authToken.length === 0) {
    throw new ConnectorError('auth', 'Twilio credential is malformed');
  }
  return { accountSid, authToken };
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export function createTwilioConnector(options: TwilioConnectorOptions = {}): ConnectorDefinition {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown> {
    if (request.action !== 'sendSms') throw new ConnectorError('validation', `unknown action "${request.action}"`);
    const input = validateSendSmsInput(request.input);
    const { accountSid, authToken } = parseTwilioCredentials(credentials);

    const form = new URLSearchParams({ To: input.to, Body: input.body });
    if (input.from) form.set('From', input.from);
    else if (input.messagingServiceSid) form.set('MessagingServiceSid', input.messagingServiceSid);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch {
      // Fixed message: the network error text can carry the URL or headers.
      throw new ConnectorError('upstream', 'Vendor request failed');
    }

    if (!response.ok) {
      throw errorFromStatus(response.status, retryAfterMs(response.headers.get('retry-after')));
    }
    const data = (await response.json().catch(() => null)) as { sid?: unknown; status?: unknown } | null;
    if (!data || typeof data.sid !== 'string') throw new ConnectorError('upstream', 'Vendor response had no message id');
    const out: SendSmsResult = { externalId: data.sid, status: typeof data.status === 'string' ? data.status : 'unknown' };
    return out;
  }

  return {
    id: TWILIO_CONNECTOR_ID,
    auth: 'api_key',
    capabilities: ['write'],
    entities: ['message'],
    actions: { sendSms: { kind: 'write', entity: 'message' } },
    execute,
  };
}
