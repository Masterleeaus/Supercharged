/**
 * Google Calendar as a ConnectorDefinition (#354). Replaces the DB-bound logic in server/services/google-calendar
 * for the connector contract. Vendor calls go through the injected HttpClient, so tests replay recorded responses.
 *
 * Idempotency: an event created for a write gets an id derived from the runner's idempotency key. A retry with the
 * same key asks Google for the same id, gets 409, and returns the event that already exists. Nothing is posted twice.
 */
import { createHash } from 'node:crypto';
import { ConnectorError, type ActionRequest, type ConnectorCredentials, type ConnectorDefinition } from '../sdk/contract.ts';
import type { HttpClient } from '../../modules/chatbot/contracts/http.ts';
import { vendorJson } from './vendor-call.ts';

export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const MAX_PAGES = 20;

export interface GoogleCalendarOptions {
  http: HttpClient;
  calendarId?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Google event ids use lowercase base32hex characters, 5 to 1024 long. A sha256 hex digest fits. */
export function googleEventIdFor(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new ConnectorError('validation', `${name} is required`);
  return v;
};

function eventTimes(input: Record<string, unknown>, timezone: string) {
  return {
    start: { dateTime: str(input.startsAt, 'startsAt'), timeZone: timezone },
    end: { dateTime: str(input.endsAt, 'endsAt'), timeZone: timezone },
  };
}

export function createGoogleCalendarConnector(options: GoogleCalendarOptions): ConnectorDefinition {
  const base = (options.baseUrl ?? GOOGLE_CALENDAR_API).replace(/\/+$/, '');
  const calendar = encodeURIComponent(options.calendarId ?? 'primary');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const eventsUrl = `${base}/calendars/${calendar}/events`;

  const call = (credentials: ConnectorCredentials, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
    vendorJson({ http: options.http, method, url, credentials, body, timeoutMs });

  async function listBusy(input: Record<string, unknown>, credentials: ConnectorCredentials) {
    const params = new URLSearchParams({
      timeMin: str(input.from, 'from'),
      timeMax: str(input.to, 'to'),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    const busy: { id: string; start: string; end: string }[] = [];
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new ConnectorError('upstream', 'Calendar listing was too long to read in full');
      const { json } = await call(credentials, 'GET', `${eventsUrl}?${params}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      const body = (json ?? {}) as { items?: unknown[]; nextPageToken?: string };
      for (const raw of body.items ?? []) {
        const item = raw as { id?: string; status?: string; transparency?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
        // All-day events have no dateTime. They are skipped here and reported as a known gap.
        if (item.status === 'cancelled' || item.transparency === 'transparent') continue;
        if (!item.start?.dateTime || !item.end?.dateTime || !item.id) continue;
        busy.push({ id: item.id, start: item.start.dateTime, end: item.end.dateTime });
      }
      if (!body.nextPageToken) return busy;
      pageToken = body.nextPageToken;
    }
  }

  async function createEvent(request: ActionRequest, input: Record<string, unknown>, credentials: ConnectorCredentials) {
    if (!request.idempotencyKey) throw new ConnectorError('validation', 'createEvent needs an idempotency key');
    const id = googleEventIdFor(request.idempotencyKey);
    const timezone = str(input.timezone, 'timezone');
    const body = {
      id,
      summary: str(input.summary, 'summary'),
      description: typeof input.description === 'string' ? input.description : undefined,
      status: input.status === 'confirmed' ? 'confirmed' : 'tentative',
      ...eventTimes(input, timezone),
    };
    try {
      const { json } = await call(credentials, 'POST', `${eventsUrl}?sendUpdates=none`, body);
      return json;
    } catch (err) {
      // 409 means this key already created the event. Return it instead of posting again.
      if (err instanceof ConnectorError && err.status === 409) {
        const { json } = await call(credentials, 'GET', `${eventsUrl}/${encodeURIComponent(id)}`);
        return json;
      }
      throw err;
    }
  }

  async function updateEvent(input: Record<string, unknown>, credentials: ConnectorCredentials) {
    const id = encodeURIComponent(str(input.eventId, 'eventId'));
    const patch: Record<string, unknown> = {};
    if (input.status === 'confirmed' || input.status === 'tentative') patch.status = input.status;
    if (typeof input.summary === 'string') patch.summary = str(input.summary, 'summary');
    if (typeof input.description === 'string') patch.description = input.description;
    if (input.startsAt !== undefined || input.endsAt !== undefined) {
      const timezone = str(input.timezone, 'timezone');
      Object.assign(patch, eventTimes(input, timezone));
    }
    if (Object.keys(patch).length === 0) throw new ConnectorError('validation', 'nothing to update');
    const { json } = await call(credentials, 'PATCH', `${eventsUrl}/${id}?sendUpdates=none`, patch);
    return json;
  }

  async function deleteEvent(input: Record<string, unknown>, credentials: ConnectorCredentials) {
    const id = encodeURIComponent(str(input.eventId, 'eventId'));
    try {
      await call(credentials, 'DELETE', `${eventsUrl}/${id}?sendUpdates=none`);
      return { deleted: true, alreadyGone: false };
    } catch (err) {
      // Google answers 410 for an event already deleted. Treat that as done, so a replayed cancel is safe.
      if (err instanceof ConnectorError && (err.status === 404 || err.status === 410)) return { deleted: true, alreadyGone: true };
      throw err;
    }
  }

  return {
    id: 'google-calendar',
    auth: 'oauth2',
    capabilities: ['read', 'write'],
    entities: ['booking'],
    actions: {
      listBusy: { kind: 'read', entity: 'booking' },
      createEvent: { kind: 'write', entity: 'booking' },
      updateEvent: { kind: 'write', entity: 'booking' },
      deleteEvent: { kind: 'write', entity: 'booking' },
    },
    async execute(request, credentials) {
      const input = (request.input ?? {}) as Record<string, unknown>;
      switch (request.action) {
        case 'listBusy':
          return listBusy(input, credentials);
        case 'createEvent':
          return createEvent(request, input, credentials);
        case 'updateEvent':
          return updateEvent(input, credentials);
        case 'deleteEvent':
          return deleteEvent(input, credentials);
        default:
          throw new ConnectorError('validation', `unknown action "${request.action}"`);
      }
    },
  };
}
