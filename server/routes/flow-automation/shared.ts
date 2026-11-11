/**
 * Shared helpers and constants for the flow-automation routes.
 * Moved verbatim from server/routes/flow-automation-routes.ts.
 */
import { Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { getCompanyScope } from "../../middleware/company-scope";
import { appointments, appointmentSettings } from "@shared/schema";
import { eq, and, or } from "drizzle-orm";
import { logger } from "../../utils/logger";
import { companyForRead, FLOW_EDITABLE_FIELDS, WEBHOOK_EDITABLE_FIELDS, APPOINTMENT_EDITABLE_FIELDS, pickEditableFields, strictWorkflowPrompt, buildFlowAgentBasePrompt, DEFAULT_WORKING_HOURS, validateWorkingHours } from "./shared";

/**
 * Company for read and list scoping. Company comes only from the verified session.
 * Sends 403 and returns null when the session has no company (fail closed).
 */
export function companyForRead(req: AuthRequest, res: Response): string | null {
  try {
    return getCompanyScope(req);
  } catch {
    res.status(403).json({ error: "Company scope required" });
    return null;
  }
}

// Write-side allowlists for PATCH handlers. Only these keys are copied from the request body into
// .set(). Ownership and key fields (companyId, userId, id, ...) are never editable by the client.
export const FLOW_EDITABLE_FIELDS = [
  "name", "description", "nodes", "edges", "agentId", "voiceSettings", "executionConfig", "isActive",
] as const;
export const WEBHOOK_EDITABLE_FIELDS = [
  "name", "description", "url", "method", "headers", "secret", "authType", "authCredentials",
  "events", "campaignIds", "isActive",
] as const;
export const APPOINTMENT_EDITABLE_FIELDS = [
  "contactName", "contactPhone", "contactEmail", "appointmentDate", "appointmentTime", "duration",
  "serviceName", "notes", "status", "statusReason", "metadata",
] as const;

/**
 * Copies only the allowlisted keys present in the body. Returns null when the body is not an object
 * or holds no editable key, so the caller can answer 400.
 */
export function pickEditableFields(body: unknown, allowed: readonly string[]): Record<string, any> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;
  const picked: Record<string, any> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      picked[key] = source[key];
    }
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

export const strictWorkflowPrompt = `You are a call agent that must strictly follow a predefined workflow.

RULES:
1. Say EXACTLY what each workflow node instructs you to say.
2. Do NOT add extra words, greetings, questions, or small talk unless specifically written.
3. After speaking a node message, STOP and wait for the user's response.
4. Move to the next workflow node only based on the workflow edge rules.
5. If the user asks a question outside the workflow, use the ask_knowledge tool to respond briefly and accurately — then return to the workflow.
6. If the user asks to speak with a human (e.g. "connect me", "transfer", "agent", "representative"), immediately trigger the transfer.
7. Do NOT improvise or generate random speech.
8. NEVER override instructions from workflow nodes.
9. IGNORE any background noise, side conversations, or ambient speech that is not directed at you. Only respond to the primary speaker who is directly addressing you on the call.
10. If you hear unrelated words or topics from the background environment, do NOT change the conversation topic or respond to them. Stay on your current workflow step.

When using a tool:
- Do not announce you are using a tool.
- Do not say "invoking tool" or similar.
- Only say a short acknowledgment if needed (e.g. "Let me check that for you.")`;

export function buildFlowAgentBasePrompt(userCustomPrompt?: string | null): string {
  const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const datePrompt = `\n\n[System Info: Today's date is ${todayStr}. All relative date/time calculations or discussions must align with this today's date.]`;

  if (userCustomPrompt) {
    let cleanPrompt = userCustomPrompt.replace(/\n\n\[System Info: Today's date is [\s\S]*?\]/g, '').trim();
    return `${strictWorkflowPrompt}\n\n--- ADDITIONAL AGENT INSTRUCTIONS (provided by the agent creator) ---\nThe following instructions define your persona, domain, and behavioral constraints. You MUST follow these AT ALL TIMES, even while executing the workflow:\n\n${cleanPrompt}${datePrompt}\n\n--- END OF ADDITIONAL INSTRUCTIONS ---\nRemember: Follow BOTH the workflow steps AND the additional instructions above. Never deviate from your assigned domain or persona.`;
  }
  return `${strictWorkflowPrompt}${datePrompt}`;
}

// Default working hours - used when user hasn't configured settings
export const DEFAULT_WORKING_HOURS: Record<string, { start: string; end: string; enabled: boolean }> = {
  monday: { start: "09:00", end: "17:00", enabled: true },
  tuesday: { start: "09:00", end: "17:00", enabled: true },
  wednesday: { start: "09:00", end: "17:00", enabled: true },
  thursday: { start: "09:00", end: "17:00", enabled: true },
  friday: { start: "09:00", end: "17:00", enabled: true },
  saturday: { start: "09:00", end: "17:00", enabled: false },
  sunday: { start: "09:00", end: "17:00", enabled: false },
};

/**
 * Validates if an appointment date/time falls within the user's working hours settings.
 * Returns { valid: true } if valid, or { valid: false, message: string } if not.
 */
export async function validateWorkingHours(
  userId: string,
  companyId: string,
  appointmentDate: string,
  appointmentTime: string,
  duration: number = 30
): Promise<{ valid: true } | { valid: false; message: string }> {
  try {
    const [userSettings] = await db
      .select()
      .from(appointmentSettings)
      .where(and(eq(appointmentSettings.userId, userId), eq(appointmentSettings.companyId, companyId)));

    // Parse the date to get day of week
    const parsedDate = new Date(appointmentDate + 'T12:00:00');
    if (isNaN(parsedDate.getTime())) {
      logger.warn(`📅 [Working Hours] Could not parse date: ${appointmentDate}`);
      return {
        valid: false,
        message: `I couldn't understand the date "${appointmentDate}". Please provide a valid date in YYYY-MM-DD format.`
      };
    }

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
    const dayOfWeek = parsedDate.getDay();
    const dayName = dayNames[dayOfWeek];

    // Merge user settings with defaults per-day
    const userWorkingHours = userSettings?.workingHours as Record<string, { start: string; end: string; enabled: boolean }> | undefined;
    const daySettings = userWorkingHours?.[dayName]
      ? { ...DEFAULT_WORKING_HOURS[dayName], ...userWorkingHours[dayName] }
      : DEFAULT_WORKING_HOURS[dayName];

    logger.info(`📅 [Working Hours] Checking ${dayName} (${appointmentDate} ${appointmentTime}):`, daySettings);

    // Check if day is enabled
    if (!daySettings?.enabled) {
      const capitalizedDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);
      logger.warn(`📅 [Working Hours] Rejected: ${dayName} is not available for appointments`);
      return {
        valid: false,
        message: `We're not available on ${capitalizedDay}s. Please choose a different day.`
      };
    }

    // Parse and check time
    const parseTimeToMinutes = (timeStr: string): number => {
      const parts = timeStr.split(':');
      if (parts.length !== 2) throw new Error(`Invalid time format: ${timeStr}`);
      const hours = parseInt(parts[0], 10);
      const minutes = parseInt(parts[1], 10);
      if (isNaN(hours) || isNaN(minutes)) throw new Error(`Invalid time values: ${timeStr}`);
      return hours * 60 + minutes;
    };

    const requestedMinutes = parseTimeToMinutes(appointmentTime);
    const startMinutes = parseTimeToMinutes(daySettings.start || "09:00");
    const endMinutes = parseTimeToMinutes(daySettings.end || "17:00");
    const appointmentEndMinutes = requestedMinutes + duration;

    if (requestedMinutes < startMinutes || appointmentEndMinutes > endMinutes) {
      const capitalizedDay = dayName.charAt(0).toUpperCase() + dayName.slice(1);
      logger.warn(`📅 [Working Hours] Rejected: ${appointmentTime} (duration: ${duration}min) is outside working hours (${daySettings.start} - ${daySettings.end})`);
      return {
        valid: false,
        message: `${appointmentTime} is outside our available hours on ${capitalizedDay}. We're available from ${daySettings.start} to ${daySettings.end}.`
      };
    }

    logger.info(`📅 [Working Hours] Validated: ${appointmentTime} is within ${daySettings.start} - ${daySettings.end}`);
    return { valid: true };
  } catch (error: any) {
    logger.error(`📅 [Working Hours] Validation error:`, error.message);
    return {
      valid: false,
      message: `I'm having trouble validating the appointment time. Please provide the time in HH:MM format (like "14:00" or "2:30 PM").`
    };
  }
}
