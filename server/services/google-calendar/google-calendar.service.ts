import { logger } from '../../utils/logger';
import { db } from "../../db";
import { googleCalendarCredentials, appointmentSettings, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getGoogleCredentials } from "../google-sheets/google-sheets.service";
import { createPinnedHttpClient } from "../../modules/chatbot/knowledge/pinned-http.ts";
import { systemWebhookResolver } from "../../modules/chatbot/events/ssrf.ts";
import { createGoogleAppointmentSync, type CalendarAppointment } from "../../connectors/calendar/google-appointment-sync.ts";
import type { AuditSink } from "../../connectors/sdk/audit.ts";

export type { CalendarAppointment } from "../../connectors/calendar/google-appointment-sync.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Vendor calls go through the connector contract and the pinned HTTP port (#354).
const googleHttp = createPinnedHttpClient({ resolve: systemWebhookResolver, maxBodyBytes: 1_000_000 });

const auditToLog: AuditSink = async (record) => {
  logger.info(
    `📅 [GoogleCalendar] ${record.action} ${record.outcome}${record.errorCode ? ` (${record.errorCode})` : ""} attempts=${record.attempts}`,
  );
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function appointmentSync(userId: string) {
  const [user] = await db
    .select({ companyId: users.companyId, timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return createGoogleAppointmentSync({
    http: googleHttp,
    audit: auditToLog,
    companyId: user?.companyId ?? userId,
    timezone: user?.timezone || "UTC",
    getAccessToken: (force) => refreshCalendarToken(userId, force),
  });
}

async function refreshCalendarToken(userId: string, force = false): Promise<string | null> {
  const [cred] = await db
    .select()
    .from(googleCalendarCredentials)
    .where(eq(googleCalendarCredentials.userId, userId))
    .limit(1);

  if (!cred) return null;

  const now = new Date();
  if (!force && cred.tokenExpiry > now) {
    return cred.accessToken;
  }

  const creds = await getGoogleCredentials();
  if (!creds) {
    logger.error("[GoogleCalendar] Google OAuth credentials not configured");
    return null;
  }

  try {
    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: cred.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!resp.ok) {
      logger.error("[GoogleCalendar] Token refresh failed:", await resp.text());
      return null;
    }

    const data = await resp.json() as { access_token: string; expires_in: number };
    const newExpiry = new Date(Date.now() + data.expires_in * 1000);

    await db
      .update(googleCalendarCredentials)
      .set({ accessToken: data.access_token, tokenExpiry: newExpiry, updatedAt: new Date() })
      .where(eq(googleCalendarCredentials.userId, userId));

    return data.access_token;
  } catch (err: unknown) {
    logger.error("[GoogleCalendar] Token refresh error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function createCalendarEvent(userId: string, apt: CalendarAppointment): Promise<string | null> {
  try {
    const eventId = await (await appointmentSync(userId)).create(apt);
    logger.info(`📅 [GoogleCalendar] Created event ${eventId} for appointment ${apt.id}`);
    return eventId;
  } catch (err: unknown) {
    logger.error("[GoogleCalendar] Create event failed:", errorText(err));
    return null;
  }
}

export async function updateCalendarEvent(userId: string, eventId: string, apt: CalendarAppointment): Promise<boolean> {
  try {
    const ok = await (await appointmentSync(userId)).update(eventId, apt);
    logger.info(`📅 [GoogleCalendar] Updated event ${eventId}`);
    return ok;
  } catch (err: unknown) {
    logger.error("[GoogleCalendar] Update event failed:", errorText(err));
    return false;
  }
}

export async function deleteCalendarEvent(userId: string, eventId: string): Promise<boolean> {
  try {
    const ok = await (await appointmentSync(userId)).remove(eventId);
    logger.info(`📅 [GoogleCalendar] Deleted event ${eventId}`);
    return ok;
  } catch (err: unknown) {
    logger.error("[GoogleCalendar] Delete event failed:", errorText(err));
    return false;
  }
}

export async function isCalendarSyncEnabled(userId: string): Promise<boolean> {
  const [cred] = await db
    .select({ id: googleCalendarCredentials.id })
    .from(googleCalendarCredentials)
    .where(eq(googleCalendarCredentials.userId, userId))
    .limit(1);

  if (!cred) return false;

  const [settings] = await db
    .select({ syncToGoogleCalendar: appointmentSettings.syncToGoogleCalendar })
    .from(appointmentSettings)
    .where(eq(appointmentSettings.userId, userId))
    .limit(1);

  return settings?.syncToGoogleCalendar ?? false;
}

export async function getCalendarConnectionStatus(userId: string): Promise<{ connected: boolean; email?: string }> {
  const [cred] = await db
    .select({ connectedEmail: googleCalendarCredentials.connectedEmail })
    .from(googleCalendarCredentials)
    .where(eq(googleCalendarCredentials.userId, userId))
    .limit(1);

  if (!cred) return { connected: false };
  return { connected: true, email: cred.connectedEmail };
}

export async function disconnectGoogleCalendar(userId: string): Promise<void> {
  await db.delete(googleCalendarCredentials).where(eq(googleCalendarCredentials.userId, userId));
}
