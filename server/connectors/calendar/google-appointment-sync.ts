/**
 * Appointment sync to Google Calendar through the connector contract (#354).
 *
 * Replaces the fetch-based create, update and delete that lived in server/services/google-calendar. This module
 * does no database work: the caller supplies the token source, the user's timezone and the HTTP port, so tests
 * replay recorded responses and never reach the network.
 *
 * Event shape, local-time handling and the summary and description text are the same as the old service, so the
 * events on the user's calendar look the same. Writes go through runAction, which adds an idempotency key, a
 * timeout, bounded retries and one audit record per call.
 */
import { ConnectorError, type ConnectorCredentials } from '../sdk/contract.ts';
import { runAction } from '../sdk/runner.ts';
import type { AuditSink } from '../sdk/audit.ts';
import type { HttpClient } from '../../modules/chatbot/contracts/http.ts';
import { createGoogleCalendarConnector } from './google-calendar.ts';

export interface CalendarAppointment {
  id: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  appointmentDate: string;
  appointmentTime: string;
  duration: number;
  serviceName: string | null;
  notes: string | null;
  status: string;
}

export interface AppointmentSyncDeps {
  http: HttpClient;
  audit: AuditSink;
  /** Tenant the audit records and idempotency keys belong to. */
  companyId: string;
  /** IANA timezone of the calendar owner. */
  timezone: string;
  /**
   * Returns an access token, or null when the user has none. force=true asks for a fresh token after the vendor
   * rejected the current one.
   */
  getAccessToken: (force: boolean) => Promise<string | null>;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Local start and end of an appointment as Google expects them with a separate timeZone field. Parsed by hand so
 * no timezone shift happens on the server.
 */
export function appointmentEventTimes(apt: CalendarAppointment): { startsAt: string; endsAt: string } {
  const dateStr = apt.appointmentDate;
  const timeStr = apt.appointmentTime.substring(0, 5);
  const startsAt = `${dateStr}T${timeStr}:00`;

  const [hoursStr, minutesStr] = timeStr.split(':');
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const startDate = new Date(
    parseInt(yearStr, 10),
    parseInt(monthStr, 10) - 1,
    parseInt(dayStr, 10),
    parseInt(hoursStr, 10),
    parseInt(minutesStr, 10),
  );
  const endDate = new Date(startDate.getTime() + apt.duration * 60 * 1000);
  const endsAt = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(
    endDate.getDate(),
  ).padStart(2, '0')}T${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}:00`;
  return { startsAt, endsAt };
}

/** Builds the connector input for an appointment: summary, description and times. */
export function appointmentEventInput(apt: CalendarAppointment, timezone: string, now: Date = new Date()) {
  const { startsAt, endsAt } = appointmentEventTimes(apt);

  const descParts: string[] = [`Phone: ${apt.contactPhone}`];
  if (apt.contactEmail) descParts.push(`Email: ${apt.contactEmail}`);
  if (apt.serviceName) descParts.push(`Service: ${apt.serviceName}`);
  descParts.push(`Duration: ${apt.duration} minutes`);
  if (apt.notes) descParts.push(`Notes: ${apt.notes}`);
  descParts.push(`\nBooked by AI agent via Diploy`);
  if (apt.status === 'completed') {
    const completedAt = now.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    descParts.push(`\nCompleted at: ${completedAt}`);
  }

  const statusLabel = apt.status.charAt(0).toUpperCase() + apt.status.slice(1);
  return {
    summary: `${statusLabel}: ${apt.contactName}${apt.serviceName ? ` — ${apt.serviceName}` : ''}`,
    description: descParts.join('\n'),
    startsAt,
    endsAt,
    timezone,
    status: 'confirmed' as const,
  };
}

export function createGoogleAppointmentSync(deps: AppointmentSyncDeps) {
  const connector = createGoogleCalendarConnector({ http: deps.http, timeoutMs: deps.timeoutMs });

  /**
   * Runs one action. On an auth error the token is refreshed once and the action is retried. A missing token is
   * not retried: the caller gets the auth error straight away.
   */
  async function run(action: string, input: Record<string, unknown>, stableId: string): Promise<Record<string, unknown>> {
    const attempt = async (force: boolean): Promise<Record<string, unknown>> => {
      const token = await deps.getAccessToken(force);
      if (!token) throw new ConnectorError('auth', 'Google Calendar is not connected for this user');
      const credentials: ConnectorCredentials = { type: 'oauth2', accessToken: token };
      const result = await runAction({
        definition: connector,
        companyId: deps.companyId,
        action,
        input,
        credentials,
        stableId,
        audit: deps.audit,
        now: deps.now,
      });
      return (result.value ?? {}) as Record<string, unknown>;
    };
    try {
      return await attempt(false);
    } catch (err) {
      if (err instanceof ConnectorError && err.code === 'auth' && !isMissingToken(err)) return attempt(true);
      throw err;
    }
  }

  return {
    /** Creates the event. Returns the Google event id. */
    async create(apt: CalendarAppointment): Promise<string> {
      const input = appointmentEventInput(apt, deps.timezone, deps.now?.());
      const value = await run('createEvent', input, `apt:${apt.id}:create:${input.startsAt}`);
      return String(value.id);
    },

    /** Updates summary, description and times of an existing event. */
    async update(eventId: string, apt: CalendarAppointment): Promise<boolean> {
      const { summary, description, startsAt, endsAt, timezone } = appointmentEventInput(apt, deps.timezone, deps.now?.());
      await run('updateEvent', { eventId, summary, description, startsAt, endsAt, timezone }, `apt:${apt.id}:update:${eventId}`);
      return true;
    },

    /** Deletes the event. An event Google already reports as gone counts as deleted. */
    async remove(eventId: string): Promise<boolean> {
      await run('deleteEvent', { eventId }, `event:${eventId}:delete`);
      return true;
    },
  };
}

const MISSING_TOKEN = 'Google Calendar is not connected for this user';
function isMissingToken(err: ConnectorError): boolean {
  return err.message === MISSING_TOKEN;
}
