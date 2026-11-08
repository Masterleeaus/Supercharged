import { db } from "../../db.js";
import { googleCalendarCredentials, appointmentSettings, users } from "../../../shared/schema.js";
import { eq } from "drizzle-orm";
import { getGoogleCredentials } from "../google-sheets/google-sheets.service.js";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
async function refreshCalendarToken(userId, force = false) {
  const [cred] = await db.select().from(googleCalendarCredentials).where(eq(googleCalendarCredentials.userId, userId)).limit(1);
  if (!cred) return null;
  const now = /* @__PURE__ */ new Date();
  if (!force && cred.tokenExpiry > now) {
    return cred.accessToken;
  }
  const creds = await getGoogleCredentials();
  if (!creds) {
    console.error("[GoogleCalendar] Google OAuth credentials not configured");
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
        grant_type: "refresh_token"
      })
    });
    if (!resp.ok) {
      console.error("[GoogleCalendar] Token refresh failed:", await resp.text());
      return null;
    }
    const data = await resp.json();
    const newExpiry = new Date(Date.now() + data.expires_in * 1e3);
    await db.update(googleCalendarCredentials).set({ accessToken: data.access_token, tokenExpiry: newExpiry, updatedAt: /* @__PURE__ */ new Date() }).where(eq(googleCalendarCredentials.userId, userId));
    return data.access_token;
  } catch (err) {
    console.error("[GoogleCalendar] Token refresh error:", err.message);
    return null;
  }
}
function buildEventBody(apt, timezone) {
  const dateStr = apt.appointmentDate;
  const timeStr = apt.appointmentTime.substring(0, 5);
  const startDateTime = `${dateStr}T${timeStr}:00`;
  const [hoursStr, minutesStr] = timeStr.split(":");
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const startYear = parseInt(yearStr, 10);
  const startMonth = parseInt(monthStr, 10) - 1;
  const startDay = parseInt(dayStr, 10);
  const startHours = parseInt(hoursStr, 10);
  const startMinutes = parseInt(minutesStr, 10);
  const startDate = new Date(startYear, startMonth, startDay, startHours, startMinutes);
  const endDate = new Date(startDate.getTime() + apt.duration * 60 * 1e3);
  const endYear = endDate.getFullYear();
  const endMonth = String(endDate.getMonth() + 1).padStart(2, "0");
  const endDay = String(endDate.getDate()).padStart(2, "0");
  const endHours = String(endDate.getHours()).padStart(2, "0");
  const endMinutes = String(endDate.getMinutes()).padStart(2, "0");
  const endDateTime = `${endYear}-${endMonth}-${endDay}T${endHours}:${endMinutes}:00`;
  const descParts = [
    `Phone: ${apt.contactPhone}`
  ];
  if (apt.contactEmail) descParts.push(`Email: ${apt.contactEmail}`);
  if (apt.serviceName) descParts.push(`Service: ${apt.serviceName}`);
  descParts.push(`Duration: ${apt.duration} minutes`);
  if (apt.notes) descParts.push(`Notes: ${apt.notes}`);
  descParts.push(`
Booked by AI agent via Diploy`);
  if (apt.status === "completed") {
    const completedAt = (/* @__PURE__ */ new Date()).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
    descParts.push(`
Completed at: ${completedAt}`);
  }
  const statusLabel = apt.status.charAt(0).toUpperCase() + apt.status.slice(1);
  return {
    summary: `${statusLabel}: ${apt.contactName}${apt.serviceName ? ` \u2014 ${apt.serviceName}` : ""}`,
    description: descParts.join("\n"),
    start: { dateTime: startDateTime, timeZone: timezone },
    end: { dateTime: endDateTime, timeZone: timezone }
  };
}
async function createCalendarEvent(userId, apt) {
  let token = await refreshCalendarToken(userId);
  if (!token) return null;
  const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
  const timezone = user?.timezone || "UTC";
  const body = buildEventBody(apt, timezone);
  const doCreate = (t) => fetch(`${GOOGLE_CALENDAR_API}/calendars/primary/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    let resp = await doCreate(token);
    if (resp.status === 401) {
      const fresh = await refreshCalendarToken(userId, true);
      if (!fresh) return null;
      resp = await doCreate(fresh);
    }
    if (!resp.ok) {
      console.error("[GoogleCalendar] Create event failed:", await resp.text());
      return null;
    }
    const data = await resp.json();
    console.log(`\u{1F4C5} [GoogleCalendar] Created event ${data.id} for appointment ${apt.id}`);
    return data.id;
  } catch (err) {
    console.error("[GoogleCalendar] Create event error:", err.message);
    return null;
  }
}
async function updateCalendarEvent(userId, eventId, apt) {
  let token = await refreshCalendarToken(userId);
  if (!token) return false;
  const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
  const timezone = user?.timezone || "UTC";
  const body = buildEventBody(apt, timezone);
  const doUpdate = (t) => fetch(`${GOOGLE_CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  try {
    let resp = await doUpdate(token);
    if (resp.status === 401) {
      const fresh = await refreshCalendarToken(userId, true);
      if (!fresh) return false;
      resp = await doUpdate(fresh);
    }
    if (!resp.ok) {
      console.error("[GoogleCalendar] Update event failed:", await resp.text());
      return false;
    }
    console.log(`\u{1F4C5} [GoogleCalendar] Updated event ${eventId}`);
    return true;
  } catch (err) {
    console.error("[GoogleCalendar] Update event error:", err.message);
    return false;
  }
}
async function deleteCalendarEvent(userId, eventId) {
  let token = await refreshCalendarToken(userId);
  if (!token) return false;
  const doDelete = (t) => fetch(`${GOOGLE_CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` }
  });
  try {
    let resp = await doDelete(token);
    if (resp.status === 401) {
      const fresh = await refreshCalendarToken(userId, true);
      if (!fresh) return false;
      resp = await doDelete(fresh);
    }
    if (resp.status === 404) {
      console.warn(`[GoogleCalendar] Event ${eventId} not found (already deleted?)`);
      return true;
    }
    if (!resp.ok) {
      console.error("[GoogleCalendar] Delete event failed:", await resp.text());
      return false;
    }
    console.log(`\u{1F4C5} [GoogleCalendar] Deleted event ${eventId}`);
    return true;
  } catch (err) {
    console.error("[GoogleCalendar] Delete event error:", err.message);
    return false;
  }
}
async function isCalendarSyncEnabled(userId) {
  const [cred] = await db.select({ id: googleCalendarCredentials.id }).from(googleCalendarCredentials).where(eq(googleCalendarCredentials.userId, userId)).limit(1);
  if (!cred) return false;
  const [settings] = await db.select({ syncToGoogleCalendar: appointmentSettings.syncToGoogleCalendar }).from(appointmentSettings).where(eq(appointmentSettings.userId, userId)).limit(1);
  return settings?.syncToGoogleCalendar ?? false;
}
async function getCalendarConnectionStatus(userId) {
  const [cred] = await db.select({ connectedEmail: googleCalendarCredentials.connectedEmail }).from(googleCalendarCredentials).where(eq(googleCalendarCredentials.userId, userId)).limit(1);
  if (!cred) return { connected: false };
  return { connected: true, email: cred.connectedEmail };
}
async function disconnectGoogleCalendar(userId) {
  await db.delete(googleCalendarCredentials).where(eq(googleCalendarCredentials.userId, userId));
}
export {
  createCalendarEvent,
  deleteCalendarEvent,
  disconnectGoogleCalendar,
  getCalendarConnectionStatus,
  isCalendarSyncEnabled,
  updateCalendarEvent
};
