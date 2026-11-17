/**
 * Microsoft 365 / Outlook calendar as a ConnectorDefinition (#354), using Microsoft Graph through the injected
 * HttpClient. Same action set as Google Calendar, so booking-ops treats both the same way.
 *
 * Idempotency: a created event carries the runner's idempotency key as the Graph transactionId, so Graph does not
 * create a second event for a retried request. Verify against the live tenant before relying on it in production.
 */
import { ConnectorError, type ActionRequest, type ConnectorCredentials, type ConnectorDefinition } from '../sdk/contract.ts';
import type { HttpClient } from '../../modules/chatbot/contracts/http.ts';
import { vendorJson } from './vendor-call.ts';

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 20;

export interface OutlookOptions {
  http: HttpClient;
  baseUrl?: string;
  timeoutMs?: number;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new ConnectorError('validation', `${name} is required`);
  return v;
};

/** Graph wants a wall-clock dateTime with its own timeZone. Sending UTC avoids any local-zone shift. */
function graphTime(iso: string): { dateTime: string; timeZone: string } {
  const d = new Date(str(iso, 'time'));
  if (Number.isNaN(d.getTime())) throw new ConnectorError('validation', 'time is not a valid instant');
  return { dateTime: d.toISOString().replace('Z', ''), timeZone: 'UTC' };
}

/** Graph returns UTC dateTime without an offset when the Prefer header asks for UTC. */
const utcInstant = (dateTime: string) => (dateTime.endsWith('Z') ? dateTime : `${dateTime}Z`);

export function createOutlookCalendarConnector(options: OutlookOptions): ConnectorDefinition {
  const base = (options.baseUrl ?? GRAPH_API).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const call = (credentials: ConnectorCredentials, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers?: Record<string, string>) =>
    vendorJson({ http: options.http, method, url, credentials, body, headers, timeoutMs });

  async function listBusy(input: Record<string, unknown>, credentials: ConnectorCredentials) {
    const params = new URLSearchParams({
      startDateTime: new Date(str(input.from, 'from')).toISOString(),
      endDateTime: new Date(str(input.to, 'to')).toISOString(),
      $select: 'id,start,end,isCancelled,showAs',
      $top: '100',
    });
    let url: string | undefined = `${base}/me/calendarView?${params}`;
    const busy: { id: string; start: string; end: string }[] = [];
    for (let page = 0; url; page++) {
      if (page >= MAX_PAGES) throw new ConnectorError('upstream', 'Calendar listing was too long to read in full');
      const { json } = await call(credentials, 'GET', url, undefined, { prefer: 'outlook.timezone="UTC"' });
      const body = (json ?? {}) as { value?: unknown[]; '@odata.nextLink'?: string };
      for (const raw of body.value ?? []) {
        const item = raw as { id?: string; isCancelled?: boolean; showAs?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
        if (item.isCancelled || item.showAs === 'free' || !item.id || !item.start?.dateTime || !item.end?.dateTime) continue;
        busy.push({ id: item.id, start: utcInstant(item.start.dateTime), end: utcInstant(item.end.dateTime) });
      }
      url = body['@odata.nextLink'];
    }
    return busy;
  }

  const showAs = (status: unknown) => (status === 'confirmed' ? 'busy' : 'tentative');

  return {
    id: 'outlook-calendar',
    auth: 'oauth2',
    capabilities: ['read', 'write'],
    entities: ['booking'],
    actions: {
      listBusy: { kind: 'read', entity: 'booking' },
      createEvent: { kind: 'write', entity: 'booking' },
      updateEvent: { kind: 'write', entity: 'booking' },
      deleteEvent: { kind: 'write', entity: 'booking' },
    },
    async execute(request: ActionRequest, credentials) {
      const input = (request.input ?? {}) as Record<string, unknown>;
      switch (request.action) {
        case 'listBusy':
          return listBusy(input, credentials);
        case 'createEvent': {
          if (!request.idempotencyKey) throw new ConnectorError('validation', 'createEvent needs an idempotency key');
          const body = {
            subject: str(input.summary, 'summary'),
            body: { contentType: 'text', content: typeof input.description === 'string' ? input.description : '' },
            start: graphTime(str(input.startsAt, 'startsAt')),
            end: graphTime(str(input.endsAt, 'endsAt')),
            showAs: showAs(input.status),
            transactionId: request.idempotencyKey,
          };
          const { json } = await call(credentials, 'POST', `${base}/me/events`, body);
          return json;
        }
        case 'updateEvent': {
          const id = encodeURIComponent(str(input.eventId, 'eventId'));
          const patch: Record<string, unknown> = {};
          if (input.status !== undefined) patch.showAs = showAs(input.status);
          if (input.startsAt !== undefined) patch.start = graphTime(str(input.startsAt, 'startsAt'));
          if (input.endsAt !== undefined) patch.end = graphTime(str(input.endsAt, 'endsAt'));
          if (Object.keys(patch).length === 0) throw new ConnectorError('validation', 'nothing to update');
          const { json } = await call(credentials, 'PATCH', `${base}/me/events/${id}`, patch);
          return json;
        }
        case 'deleteEvent': {
          const id = encodeURIComponent(str(input.eventId, 'eventId'));
          try {
            await call(credentials, 'DELETE', `${base}/me/events/${id}`);
            return { deleted: true, alreadyGone: false };
          } catch (err) {
            // Graph answers 404 for an event that is already gone. A replayed cancel is therefore safe.
            if (err instanceof ConnectorError && err.status === 404) return { deleted: true, alreadyGone: true };
            throw err;
          }
        }
        default:
          throw new ConnectorError('validation', `unknown action "${request.action}"`);
      }
    },
  };
}
