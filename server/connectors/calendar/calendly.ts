/**
 * Calendly as a ConnectorDefinition (#354). This is an adapter over the existing provider in
 * server/modules/chatbot/booking-providers/calendly.ts, which keeps its request, pagination, webhook and
 * URL-host rules. Nothing about the Calendly protocol is duplicated here.
 *
 * The provider's own enabled flag is bypassed because the connector registry now owns enablement. Errors from
 * the provider are mapped onto the SDK taxonomy, so the shared runner handles retries and audit the same way as
 * for every other connector.
 *
 * Idempotency: Calendly has no request-level key. Booking retries are blocked by booking-caller.ts (one attempt row
 * per key), which runs before this connector is called. A write here is not idempotent on its own.
 */
import { ConnectorError, errorFromStatus, type ActionRequest, type ConnectorCredentials, type ConnectorDefinition } from '../sdk/contract.ts';
import { createCalendlyProvider, CALENDLY_TOKEN_KEY } from '../../modules/chatbot/booking-providers/calendly.ts';
import { CalendarProviderError } from '../../modules/chatbot/booking-providers/errors.ts';
import type { HttpClient } from '../../modules/chatbot/contracts/http.ts';
import { accessTokenOf } from './vendor-call.ts';

export interface CalendlyConnectorOptions {
  http: HttpClient;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Maps a provider error to the SDK taxonomy. The provider's messages are fixed strings, so they are safe to pass on. */
export function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  if (err instanceof CalendarProviderError) {
    if (err.code === 'invalid_request' || err.code === 'config') return new ConnectorError('validation', err.message);
    if (err.code === 'timeout') return new ConnectorError('timeout', err.message);
    if (err.code === 'network' || err.code === 'bad_response') return new ConnectorError('upstream', err.message);
    if (err.status !== null) return errorFromStatus(err.status);
  }
  return new ConnectorError('unknown', 'Unexpected connector failure');
}

export function createCalendlyConnector(options: CalendlyConnectorOptions): ConnectorDefinition {
  const provider = createCalendlyProvider({ enabled: true, baseUrl: options.baseUrl, timeoutMs: options.timeoutMs, env: {} });
  const creds = (credentials: ConnectorCredentials): Record<string, string> => ({ [CALENDLY_TOKEN_KEY]: accessTokenOf(credentials) });

  /** The provider needs the company and connection reference. Callers pass them in the input. */
  const ref = (input: Record<string, unknown>) => {
    const r = input.ref as Record<string, unknown> | undefined;
    if (!r || typeof r.companyId !== 'string' || typeof r.chatbotId !== 'string' || typeof r.externalEventTypeId !== 'string') {
      throw new ConnectorError('validation', 'ref needs companyId, chatbotId and externalEventTypeId');
    }
    return { companyId: r.companyId, chatbotId: r.chatbotId, provider: 'calendly' as const, externalEventTypeId: r.externalEventTypeId };
  };

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toConnectorError(err);
    }
  }

  return {
    id: 'calendly',
    auth: 'api_key',
    capabilities: ['read', 'write'],
    entities: ['booking'],
    actions: {
      listEventTypes: { kind: 'read', entity: 'booking' },
      listSlots: { kind: 'read', entity: 'booking' },
      listBookings: { kind: 'read', entity: 'booking' },
      createBooking: { kind: 'write', entity: 'booking' },
      cancelBooking: { kind: 'write', entity: 'booking' },
    },
    async execute(request: ActionRequest, credentials) {
      const input = (request.input ?? {}) as Record<string, unknown>;
      const c = creds(credentials);
      return run(async () => {
        switch (request.action) {
          case 'listEventTypes': {
            const r = ref(input);
            return provider.listEventTypes(r.companyId, r.chatbotId, c, options.http);
          }
          case 'listSlots':
            return provider.listSlots(ref(input), input.window as never, c, options.http);
          case 'listBookings':
            return provider.listBookings(ref(input), input.window as never, c, options.http);
          case 'createBooking':
            return provider.createBooking(ref(input), input.request as never, c, options.http);
          case 'cancelBooking':
            return provider.cancelBooking(ref(input), String(input.externalBookingId ?? ''), (input.reason as string) ?? null, c, options.http);
          default:
            throw new ConnectorError('validation', `unknown action "${request.action}"`);
        }
      });
    },
  };
}
