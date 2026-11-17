'use strict';
/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { Request, Response } from 'express';
import { db } from '../../db';
import { calls, contacts, agents, appointments, appointmentSettings } from '../../../shared/schema';
import { nanoid } from 'nanoid';
import { eq, and, or, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { webhookDeliveryService } from '../../services/webhook-delivery';
import { createCalendarEvent, isCalendarSyncEnabled } from '../../services/google-calendar/google-calendar.service';
// Static imports for appointment webhook - moved from dynamic imports to reduce latency
import * as chrono from 'chrono-node';
import { format as formatDate, addDays } from 'date-fns';
import {
  APPOINTMENT_WEBHOOK_SECRET_HEADER,
  appointmentReplayKey,
  authenticateAppointmentRequest,
  getAppointmentWebhookSecret,
} from '../../services/appointment-elevenlabs-tool';
import { findCallForWebhook } from '../../services/call-matcher';

/**
 * Appointment Booking Tool Webhook Handler
 * 
 * This endpoint is called by ElevenLabs when a Flow Agent uses the book_appointment tool.
 * It saves the appointment to the database.
 * 
 * Features:
 * - Parses natural language dates (e.g., "tomorrow", "next Monday", "Oct 3")
 * - Uses actual caller phone number from call record as verified source
 * - Stores both AI-collected and verified phone numbers for discrepancy detection
 * 
 * Security: The secret is read from the X-Appointment-Webhook-Secret header and compared in constant time.
 * The legacy URL-token route is accepted only while APPOINTMENT_WEBHOOK_ALLOW_URL_TOKEN is not "false".
 *
 * Endpoints: POST /api/webhooks/elevenlabs/appointment/:elevenLabsAgentId (header auth)
 *            POST /api/webhooks/elevenlabs/appointment/:token/:elevenLabsAgentId (legacy, time-bounded)
 */
export async function handleAppointmentToolWebhook(req: Request, res: Response) {
  // CRITICAL: Log immediately on entry - before ANY async operations
  // This confirms whether ElevenLabs is reaching our endpoint at all
  const startTime = Date.now();
  logger.info(`📅 [Appointment Webhook] ===== WEBHOOK HIT =====`);
  logger.info(`📅 [Appointment Webhook] Timestamp: ${new Date().toISOString()}`);

  const { token: urlToken, agentId: elevenLabsAgentId } = req.params;
  const { callId } = req.query;

  logger.info(`📅 [Appointment Webhook] Agent: ${elevenLabsAgentId}, CallId: ${callId || 'none'}`);

  try {
    // NOTE: Using static imports (at top of file) instead of dynamic imports
    // Dynamic imports added 200-500ms latency causing ElevenLabs timeouts

    // Secret travels in the X-Appointment-Webhook-Secret header. The legacy URL token is honoured only
    // while APPOINTMENT_WEBHOOK_ALLOW_URL_TOKEN is not "false" (time-bounded migration).
    const rawHeaderToken = req.get(APPOINTMENT_WEBHOOK_SECRET_HEADER);
    let auth: { ok: boolean; via: 'header' | 'url' | null };
    try {
      auth = authenticateAppointmentRequest(
        { headerToken: rawHeaderToken, pathToken: urlToken },
        getAppointmentWebhookSecret(),
      );
    } catch {
      auth = { ok: false, via: null }; // no secret configured: fail closed
    }
    if (!auth.ok) {
      logger.warn(`📅 [Appointment Webhook] Invalid authentication token`);
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Invalid authentication token"
      });
    }
    if (auth.via === 'url') {
      logger.warn(`📅 [Appointment Webhook] Legacy URL-token auth used; migrate this tool to the header`);
    }

    logger.info(`📅 [Appointment Webhook] Authentication successful`);
    logger.info(`   Request body:`);

    const {
      contactName,
      contactPhone: rawContactPhone,
      contactEmail,
      appointmentDate,
      appointmentTime,
      duration,
      serviceName,
      notes,
      conversationId,
      conversation_id
    } = req.body;

    // Normalize contactPhone - resolve system variables, sentinel values, and invalid text
    // Priority: 
    // 1. ElevenLabs system__caller_id (auto-resolved to actual phone by ElevenLabs before webhook)
    // 2. Explicit phone number provided by the caller
    // 3. Legacy USE_CALLER_NUMBER sentinel (fallback to call record lookup)
    let contactPhone: string | null = null;

    if (rawContactPhone) {
      const digits = rawContactPhone.replace(/[^0-9+]/g, '');
      const digitCount = rawContactPhone.replace(/[^0-9]/g, '').length;

      if (digitCount >= 6) {
        // Looks like a real phone number (either from system__caller_id resolution or caller-provided)
        contactPhone = rawContactPhone;
        logger.info(`📅 [Appointment Webhook] Using phone number: [redacted]`);
      } else if (rawContactPhone === 'USE_CALLER_NUMBER' ||
        rawContactPhone === '{{system__caller_id}}' ||
        rawContactPhone?.toLowerCase()?.includes('same') ||
        rawContactPhone?.toLowerCase()?.includes('calling') ||
        rawContactPhone?.toLowerCase()?.includes('called') ||
        rawContactPhone?.toLowerCase()?.includes('system__caller')) {
        logger.info(`📅 [Appointment Webhook] Caller number placeholder detected: "[redacted]" - will resolve from call record`);
      } else {
        logger.warn(`📅 [Appointment Webhook] AI sent invalid phone text: "[redacted]" - will resolve from call record`);
      }
    } else {
      logger.info(`📅 [Appointment Webhook] No phone provided - will resolve from call record`);
    }

    // Look up agent by ElevenLabs agent ID to get database agent ID and userId
    let agent = await db
      .select({ id: agents.id, userId: agents.userId, companyId: agents.companyId, flowId: agents.flowId, name: agents.name })
      .from(agents)
      .where(eq(agents.elevenLabsAgentId, elevenLabsAgentId))
      .limit(1);

    // Fallback: If agent not found by ElevenLabs ID, try to find via SIP call record using callId
    // This is a safe, deterministic lookup using the callId parameter
    if (agent.length === 0 && callId) {
      logger.warn(`📅 [Appointment Webhook] Agent not found by ElevenLabs ID, trying callId fallback...`);

      // Look up SIP call by external call ID or call ID to find the correct agent
      // This is safe because we're using the callId from the request, not guessing
      const sipCallByCallId = await db.execute(sql`
        SELECT sc.agent_id, a.id as agent_id_verified, a.user_id, a.company_id, a.flow_id, a.name as agent_name, sc.id as call_id
        FROM sip_calls sc
        JOIN agents a ON sc.agent_id = a.id
        WHERE (sc.external_call_id = ${callId} OR sc.id = ${callId} OR sc.elevenlabs_conversation_id = ${callId})
          AND sc.engine = 'elevenlabs-sip'
        LIMIT 1
      `);

      if (sipCallByCallId.rows.length > 0) {
        const sipCallAgent = sipCallByCallId.rows[0] as any;
        logger.info(`📅 [Appointment Webhook] Found agent via SIP call record ${sipCallAgent.call_id}: ${sipCallAgent.agent_id_verified}`);
        agent = [{
          id: sipCallAgent.agent_id_verified,
          userId: sipCallAgent.user_id,
          companyId: sipCallAgent.company_id ?? null,
          flowId: sipCallAgent.flow_id,
          name: sipCallAgent.agent_name
        }];
      }
    }

    // If still no agent found, log detailed error for debugging
    // NOTE: We intentionally do NOT use global/unscoped fallbacks as they could cause cross-tenant issues
    if (agent.length === 0) {
      logger.warn(`📅 [Appointment Webhook] ⚠️ STALE AGENT ID DETECTED`);
      logger.warn(`   ElevenLabs is using agent ID: ${elevenLabsAgentId}`);
      logger.warn(`   This ID does not exist in our database.`);
      logger.warn(`   CallId provided: ${callId || 'none'}`);
      logger.warn(`   To fix: Re-assign the agent to the SIP phone number. This will refresh the webhook URL on ElevenLabs.`);
    }

    if (agent.length === 0) {
      logger.warn(`📅 [Appointment Webhook] No agent found with ElevenLabs ID ${elevenLabsAgentId} (including SIP fallback)`);
      return res.json({
        success: false,
        message: "Could not find the agent to book the appointment."
      });
    }

    const dbAgentId = agent[0].id;
    const userId = agent[0].userId;
    const flowId = agent[0].flowId;
    // Provider webhooks carry no session, so company comes from the owning agent record.
    // Fail closed: refuse rather than insert an appointment without company_id.
    const companyId: string | null = agent[0].companyId ?? null;
    if (!companyId) {
      logger.warn(`📅 [Appointment Webhook] Refusing appointment insert: agent ${dbAgentId} has no company_id`);
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    logger.info(`📅 [Appointment Webhook] Found database agent ${dbAgentId} for user ${userId}`);

    // Get call record to extract verified caller phone number
    // Strategy: Try explicit callId first, then use call matcher to find recent calls for this agent
    let validatedCallId: string | null = null;
    let verifiedCallerPhone: string | null = null;
    let verifiedCallerName: string | null = null;

    // Try explicit callId if provided (legacy support)
    if (callId) {
      const callRecord = await db
        .select({
          id: calls.id,
          userId: calls.userId,
          companyId: calls.companyId,
          phoneNumber: calls.phoneNumber,
          callDirection: calls.callDirection,
          contactId: calls.contactId
        })
        .from(calls)
        .where(and(
          eq(calls.id, callId as string),
          eq(calls.userId, userId)
        ))
        .limit(1);

      // Cross-company guard: a call from another company must never be linked to this agent's booking.
      if (callRecord.length > 0 && callRecord[0].companyId && callRecord[0].companyId !== companyId) {
        logger.warn(`📅 [Appointment Webhook] Refusing cross-company call link for agent ${dbAgentId}`);
        return res.status(403).json({ success: false, message: "Forbidden" });
      }

      if (callRecord.length > 0) {
        validatedCallId = callRecord[0].id;
        verifiedCallerPhone = callRecord[0].phoneNumber;
        logger.info(`📅 [Appointment Webhook] Found call by explicit ID: ${validatedCallId}`);

        if (callRecord[0].contactId) {
          const contactRecord = await db
            .select({
              firstName: contacts.firstName,
              lastName: contacts.lastName,
              phone: contacts.phone
            })
            .from(contacts)
            .where(eq(contacts.id, callRecord[0].contactId))
            .limit(1);
          if (contactRecord.length > 0) {
            verifiedCallerName = [contactRecord[0].firstName, contactRecord[0].lastName].filter(Boolean).join(' ');
            verifiedCallerPhone = contactRecord[0].phone || verifiedCallerPhone;
            logger.info(`📅 [Appointment Webhook] Verified contact: ${verifiedCallerName} ([redacted])`);
          }
        }
      }
    }

    // If no explicit callId, use call matcher to find recent calls for this agent/phone
    if (!validatedCallId) {
      const matchedCall = await findCallForWebhook(elevenLabsAgentId, contactPhone, userId);

      if (matchedCall) {
        validatedCallId = matchedCall.callId;
        verifiedCallerPhone = matchedCall.verifiedContactPhone || matchedCall.phoneNumber;
        verifiedCallerName = matchedCall.contactName;
        logger.info(`📅 [Appointment Webhook] Matched call via call-matcher: ${validatedCallId}`);
      } else {
        logger.info(`📅 [Appointment Webhook] No call match found - appointment will be saved without call link`);
      }
    }

    // Use verified phone from call record as primary, AI-collected as fallback
    // When AI doesn't provide contactPhone (because caller confirmed using their calling number),
    // we MUST have a verified phone from the call record
    const finalContactPhone = verifiedCallerPhone || contactPhone;
    const finalContactName = verifiedCallerName || contactName || 'Unknown Caller';

    // Log which phone source we're using
    if (verifiedCallerPhone && !contactPhone) {
      logger.info(`📅 [Appointment Webhook] Using verified caller phone from call record: [redacted]`);
    } else if (verifiedCallerPhone && contactPhone && verifiedCallerPhone !== contactPhone) {
      logger.info(`📅 [Appointment Webhook] Caller provided different phone: [redacted] (call record: [redacted])`);
    }

    if (!finalContactPhone) {
      logger.warn(`📅 [Appointment Webhook] No phone number available - call not matched and AI didn't collect phone`);
      return res.json({
        success: false,
        message: "I couldn't identify your phone number. Could you please provide a contact number for the appointment?"
      });
    }

    if (!appointmentDate || !appointmentTime) {
      logger.warn(`📅 [Appointment Webhook] Missing date/time`);
      return res.json({
        success: false,
        message: "I need both the date and time to schedule the appointment."
      });
    }

    // Parse natural language date using chrono-node
    let parsedDate: Date | null = null;
    let parsedTime: string = appointmentTime;

    // First, try to parse date as-is (might be YYYY-MM-DD already)
    const isoDateMatch = appointmentDate.match(/^\d{4}-\d{2}-\d{2}$/);
    if (isoDateMatch) {
      parsedDate = new Date(appointmentDate + 'T12:00:00');
      logger.info(`📅 [Appointment Webhook] Date already in ISO format: ${appointmentDate}`);
    } else {
      // Parse natural language date (e.g., "tomorrow", "next Monday", "Oct 3")
      const dateTimeString = `${appointmentDate} ${appointmentTime}`;
      const chronoResult = chrono.parseDate(dateTimeString, new Date(), { forwardDate: true });

      if (chronoResult) {
        parsedDate = chronoResult;
        logger.info(`📅 [Appointment Webhook] Parsed natural language date: "${appointmentDate}" -> ${parsedDate.toISOString()}`);
      } else {
        // Try parsing just the date
        const dateOnlyResult = chrono.parseDate(appointmentDate, new Date(), { forwardDate: true });
        if (dateOnlyResult) {
          parsedDate = dateOnlyResult;
          logger.info(`📅 [Appointment Webhook] Parsed date only: "${appointmentDate}" -> ${parsedDate.toISOString()}`);
        }
      }
    }

    // If still couldn't parse, try common patterns
    if (!parsedDate) {
      // Handle common relative terms
      const lowerDate = appointmentDate.toLowerCase().trim();
      const now = new Date();

      if (lowerDate === 'tomorrow') {
        parsedDate = addDays(now, 1);
      } else if (lowerDate === 'today') {
        parsedDate = now;
      } else if (lowerDate === 'day after tomorrow') {
        parsedDate = addDays(now, 2);
      } else if (lowerDate.includes('next week')) {
        parsedDate = addDays(now, 7);
      }

      if (parsedDate) {
        logger.info(`📅 [Appointment Webhook] Parsed relative date: "${appointmentDate}" -> ${parsedDate.toISOString()}`);
      }
    }

    if (!parsedDate) {
      logger.warn(`📅 [Appointment Webhook] Could not parse date: "${appointmentDate}"`);
      return res.json({
        success: false,
        message: `I couldn't understand the date "${appointmentDate}". Please provide a specific date like "tomorrow", "December 5th", or "next Monday".`
      });
    }

    // Validate that the date is not in the past
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const appointmentDay = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());

    if (appointmentDay < today) {
      logger.warn(`📅 [Appointment Webhook] Date is in the past: ${appointmentDate} -> ${parsedDate.toISOString()}`);
      const currentYear = now.getFullYear();
      return res.json({
        success: false,
        message: `That date appears to be in the past. Please provide a future date. We're currently in ${currentYear}.`
      });
    }

    // Format date and time for database
    const finalDate = formatDate(parsedDate, 'yyyy-MM-dd');

    // Parse time - try to extract from chrono result or use provided time
    let finalTime = '10:00'; // Default fallback
    const timeMatch = appointmentTime.match(/(\d{1,2}):?(\d{2})?\s*(am|pm|AM|PM)?/);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const ampm = timeMatch[3]?.toLowerCase();

      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;

      finalTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    } else if (appointmentTime.match(/^\d{2}:\d{2}$/)) {
      finalTime = appointmentTime;
    }

    logger.info(`📅 [Appointment Webhook] Final parsed date/time: ${finalDate} at ${finalTime}`);

    // Validate against user's working hours settings
    const [userSettings] = await db
      .select()
      .from(appointmentSettings)
      .where(eq(appointmentSettings.userId, userId));

    // Default working hours - used when user hasn't configured settings or individual days are missing
    const defaultWorkingHours: Record<string, { start: string; end: string; enabled: boolean }> = {
      monday: { start: "09:00", end: "17:00", enabled: true },
      tuesday: { start: "09:00", end: "17:00", enabled: true },
      wednesday: { start: "09:00", end: "17:00", enabled: true },
      thursday: { start: "09:00", end: "17:00", enabled: true },
      friday: { start: "09:00", end: "17:00", enabled: true },
      saturday: { start: "09:00", end: "17:00", enabled: false },
      sunday: { start: "09:00", end: "17:00", enabled: false },
    };

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
    const dayOfWeek = parsedDate.getDay();
    const dayName = dayNames[dayOfWeek];

    // Merge user settings with defaults per-day to handle missing keys in stored data
    const userWorkingHours = userSettings?.workingHours as Record<string, { start: string; end: string; enabled: boolean }> | undefined;
    const daySettings = userWorkingHours?.[dayName]
      ? { ...defaultWorkingHours[dayName], ...userWorkingHours[dayName] }
      : defaultWorkingHours[dayName];

    logger.info(`📅 [Appointment Webhook] Working hours for ${dayName}:`, daySettings);

    if (!daySettings?.enabled) {
      logger.warn(`📅 [Appointment Webhook] Rejected: ${dayName} is not available for appointments`);
      return res.json({
        success: false,
        message: `I'm sorry, but we're not available on ${dayName.charAt(0).toUpperCase() + dayName.slice(1)}s. Please choose a different day.`
      });
    }

    // Check if the time is within working hours (with defensive parsing)
    try {
      const parseTimeToMinutes = (timeStr: string): number => {
        const parts = timeStr.split(':');
        if (parts.length !== 2) throw new Error(`Invalid time format: ${timeStr}`);
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        if (isNaN(hours) || isNaN(minutes)) throw new Error(`Invalid time values: ${timeStr}`);
        return hours * 60 + minutes;
      };

      const requestedMinutes = parseTimeToMinutes(finalTime);
      const startMinutes = parseTimeToMinutes(daySettings.start || "09:00");
      const endMinutes = parseTimeToMinutes(daySettings.end || "17:00");
      const appointmentDuration = duration || 30;

      // Check if appointment START is within working hours (inclusive of end time for start)
      // and appointment END doesn't exceed working hours
      const appointmentEndMinutes = requestedMinutes + appointmentDuration;

      if (requestedMinutes < startMinutes || appointmentEndMinutes > endMinutes) {
        logger.warn(`📅 [Appointment Webhook] Rejected: ${finalTime} (duration: ${appointmentDuration}min) is outside working hours (${daySettings.start} - ${daySettings.end})`);
        return res.json({
          success: false,
          message: `I'm sorry, but ${finalTime} is outside our available hours on ${dayName.charAt(0).toUpperCase() + dayName.slice(1)}. We're available from ${daySettings.start} to ${daySettings.end}. Would you like to choose a different time?`
        });
      }

      logger.info(`📅 [Appointment Webhook] Time validation passed: ${finalTime} is within ${daySettings.start} - ${daySettings.end}`);
    } catch (parseError: any) {
      logger.error(`📅 [Appointment Webhook] Time parsing error:`, parseError.message);
      logger.error(`📅 [Appointment Webhook] daySettings:`, JSON.stringify(daySettings));
      logger.error(`📅 [Appointment Webhook] finalTime:`, finalTime);
      // Reject the booking with a helpful message rather than silently allowing
      return res.json({
        success: false,
        message: `I'm having trouble understanding the appointment time. Could you please specify the time again, like "2 PM" or "14:00"?`
      });
    }

    // Build metadata to track phone number discrepancies
    const metadata: Record<string, any> = {};
    const finalConvId = conversationId || conversation_id || null;
    if (finalConvId) {
      metadata.elevenLabsConversationId = finalConvId;
      logger.info(`📅 [Appointment Webhook] Received ElevenLabs Conversation ID: ${finalConvId}`);
    }
    // Store the ElevenLabs agent ID for matching during appointment linking
    if (elevenLabsAgentId) {
      metadata.elevenLabsAgentId = elevenLabsAgentId;
      metadata.agentId = dbAgentId;
      metadata.agentName = agent[0]?.name;
    }
    if (contactPhone && verifiedCallerPhone && contactPhone !== verifiedCallerPhone) {
      metadata.aiCollectedPhone = contactPhone;
      metadata.verifiedPhone = verifiedCallerPhone;
      metadata.phoneDiscrepancy = true;
      logger.info(`📅 [Appointment Webhook] Phone discrepancy detected:`);
      logger.info(`   AI collected: [redacted]`);
      logger.info(`   Verified (call): [redacted]`);
    }
    if (contactName && verifiedCallerName && contactName !== verifiedCallerName) {
      metadata.aiCollectedName = contactName;
      metadata.verifiedName = verifiedCallerName;
    }

    // Replay protection: a retried tool call for the same conversation, company, slot and phone
    // returns the appointment already created instead of inserting a duplicate.
    let replayKey: string | null = null;
    if (finalConvId) {
      replayKey = appointmentReplayKey({
        companyId,
        conversationId: String(finalConvId),
        date: finalDate,
        time: finalTime,
        phone: finalContactPhone,
      });
      metadata.replayKey = replayKey;
      const [existing] = await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(
          eq(appointments.companyId, companyId),
          sql`${appointments.metadata}->>'replayKey' = ${replayKey}`
        ))
        .limit(1);
      if (existing) {
        logger.info(`📅 [Appointment Webhook] Replayed request; returning existing appointment ${existing.id}`);
        return res.json({
          success: true,
          message: "Your appointment is already booked.",
          appointmentId: existing.id
        });
      }
    }

    const appointmentId = nanoid();
    const [newAppointment] = await db
      .insert(appointments)
      .values({
        id: appointmentId,
        userId,
        companyId,
        callId: validatedCallId,
        flowId: flowId || null,
        contactName: finalContactName,
        contactPhone: finalContactPhone,
        contactEmail: contactEmail || null,
        appointmentDate: finalDate,
        appointmentTime: finalTime,
        duration: duration || 30,
        serviceName: serviceName || null,
        notes: notes || null,
        status: "scheduled",
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      })
      .returning();

    logger.info(`📅 [Appointment Webhook] Created appointment ${appointmentId}`);
    logger.info(`   Contact: ${finalContactName} ([redacted])`);
    logger.info(`   Date/Time: ${finalDate} at ${finalTime}`);

    // Auto-sync to Google Calendar if enabled
    try {
      const syncEnabled = await isCalendarSyncEnabled(userId);
      if (syncEnabled) {
        const calendarApt = {
          id: appointmentId,
          contactName: finalContactName,
          contactPhone: finalContactPhone,
          contactEmail: contactEmail || null,
          appointmentDate: finalDate,
          appointmentTime: finalTime,
          duration: duration || 30,
          serviceName: serviceName || null,
          notes: notes || null,
          status: "scheduled",
        };
        const eventId = await createCalendarEvent(userId, calendarApt);
        if (eventId) {
          await db
            .update(appointments)
            .set({ googleCalendarEventId: eventId, updatedAt: new Date() })
            .where(eq(appointments.id, appointmentId));
          logger.info(`📅 [GoogleCalendar] Auto-synced appointment ${appointmentId} → event ${eventId}`);
        }
      }
    } catch (calErr: any) {
      logger.error(`📅 [GoogleCalendar] Auto-sync error for ${appointmentId}:`, calErr.message);
    }

    // Trigger appointment.booked webhook event
    try {
      await webhookDeliveryService.triggerEvent(agent[0].companyId ?? null, userId, 'appointment.booked', {
        appointment: {
          id: appointmentId,
          contactName: finalContactName,
          contactPhone: finalContactPhone,
          contactEmail: contactEmail || null,
          date: finalDate,
          time: finalTime,
          duration: duration || 30,
          serviceName: serviceName || null,
          notes: notes || null,
          status: 'scheduled',
          createdAt: new Date().toISOString(),
        },
        call: {
          id: validatedCallId || null,
        },
        flow: {
          id: flowId || null,
        },
      });
      logger.info(`📅 [Appointment Webhook] Triggered appointment.booked webhook event`);
    } catch (webhookError: any) {
      logger.error(`📅 [Appointment Webhook] Failed to trigger webhook:`, webhookError.message);
    }

    // Update call metadata for CRM Lead Processor detection
    if (validatedCallId) {
      try {
        const [existingCall] = await db
          .select()
          .from(calls)
          .where(eq(calls.id, validatedCallId))
          .limit(1);

        if (existingCall) {
          const existingMetadata = (existingCall.metadata as Record<string, unknown>) || {};
          const existingAiInsights = (existingMetadata.aiInsights as Record<string, unknown>) || {};

          const updatedMetadata = {
            ...existingMetadata,
            appointmentBooked: true,
            hasAppointment: true,
            appointmentData: {
              appointmentId,
              contactName: finalContactName,
              contactPhone: finalContactPhone,
              date: finalDate,
              time: finalTime,
              bookedAt: new Date().toISOString(),
            },
            aiInsights: {
              ...existingAiInsights,
              primaryOutcome: 'appointment_booked',
              appointmentBooked: true,
            },
          };

          await db
            .update(calls)
            .set({ metadata: updatedMetadata })
            .where(eq(calls.id, validatedCallId));

          logger.info(`📅 [Appointment Webhook] Updated call metadata for CRM detection`);
        }
      } catch (metadataError: any) {
        logger.error(`📅 [Appointment Webhook] Failed to update call metadata:`, metadataError.message);
      }
    }

    // Format response date for human readability
    const readableDate = formatDate(parsedDate, 'EEEE, MMMM d, yyyy');
    const readableTime = formatDate(new Date(`2000-01-01T${finalTime}`), 'h:mm a');

    const responseTime = Date.now() - startTime;
    logger.info(`📅 [Appointment Webhook] ✅ SUCCESS - Response time: ${responseTime}ms`);

    return res.json({
      success: true,
      message: `Great! I've booked your appointment for ${readableDate} at ${readableTime}. You'll receive a confirmation shortly.`,
      appointmentId: appointmentId
    });

  } catch (error: any) {
    const responseTime = Date.now() - startTime;
    logger.error(`❌ [Appointment Webhook] Error after ${responseTime}ms:`, error.message);
    logger.error(`   Stack:`, error.stack);
    return res.json({
      success: false,
      message: "I encountered an error while booking the appointment. Please try again."
    });
  }
}
