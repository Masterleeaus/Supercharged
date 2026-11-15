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
import { Response } from 'express';
import { db } from '../../db';
import { calls, appointments } from '../../../shared/schema';
import { sql } from 'drizzle-orm';
import { getTwilioClient } from '../../services/twilio-connector';
import { logger } from '../../utils/logger';

export async function linkPendingAppointments(params: {
  userId: string;
  callId: string;
  conversationId?: string;
  phoneNumber?: string;
  isSipCall?: boolean;
}) {
  const { userId, callId, conversationId, phoneNumber, isSipCall } = params;
  try {
    if (conversationId) {
      const result = await db.execute(sql`
        UPDATE appointments 
        SET call_id = ${callId}, updated_at = NOW()
        WHERE user_id = ${userId}
          AND call_id IS NULL
          AND (metadata->>'elevenLabsConversationId' = ${conversationId} OR metadata->>'conversationId' = ${conversationId})
      `);
      const rowCount = result.rowCount || 0;
      if (rowCount > 0) {
        logger.info(`📅 [Appointment Linker] Linked ${rowCount} appointment(s) to call ${callId} via conversationId: ${conversationId}`);
        const table = isSipCall ? 'sip_calls' : 'calls';
        await db.execute(sql`
          UPDATE ${sql.identifier(table)}
          SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ appointmentBooked: true, hasAppointment: true })}::jsonb
          WHERE id = ${callId}
        `);
        return;
      }
    }

    if (phoneNumber) {
      const digits = phoneNumber.replace(/[^0-9]/g, '');
      if (digits.length >= 6) {
        const last10 = digits.slice(-10);

        const recentAppts = await db.execute(sql`
          SELECT id, contact_phone FROM appointments
          WHERE user_id = ${userId}
            AND call_id IS NULL
            AND created_at > NOW() - INTERVAL '10 minutes'
        `);

        for (const row of recentAppts.rows as any[]) {
          const apptDigits = (row.contact_phone || '').replace(/[^0-9]/g, '');
          const apptLast10 = apptDigits.slice(-10);

          const phoneMatches = apptLast10 === last10;
          const fuzzyPhoneMatch = apptLast10.length === 10 && last10.length === 10 &&
            apptLast10.split('').filter((d: string, i: number) => d === last10[i]).length >= 9;

          if (phoneMatches || fuzzyPhoneMatch) {
            logger.info(`📅 [Appointment Linker] Linked appointment ${row.id} to call ${callId} via phone number match`);
            await db.execute(sql`
              UPDATE appointments 
              SET call_id = ${callId}, updated_at = NOW()
              WHERE id = ${row.id}
            `);
            const table = isSipCall ? 'sip_calls' : 'calls';
            await db.execute(sql`
              UPDATE ${sql.identifier(table)}
              SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ appointmentBooked: true, hasAppointment: true })}::jsonb
              WHERE id = ${callId}
            `);
          }
        }
      }
    }
  } catch (err: any) {
    logger.error(`❌ [Appointment Linker] Error linking pending appointments:`, err.message);
  }
}

// Helper function to end Twilio call
export async function endTwilioCall(twilioCallSid: string | null, reason: string): Promise<void> {
  try {
    if (!twilioCallSid) {
      logger.error(`❌ [Call End Failed] No Twilio CallSid available`);
      return;
    }

    logger.info(`📞 [Ending Call] Reason: ${reason}`);
    logger.info(`   CallSid: ${twilioCallSid}`);

    const twilioClient = await getTwilioClient();
    await twilioClient.calls(twilioCallSid).update({ status: 'completed' });

    logger.info(`✅ [Call Ended Successfully] CallSid: ${twilioCallSid}`);
  } catch (error) {
    logger.error(`❌ [Call End Error]`, error);
  }
}

// Helper function to execute call transfer via Twilio REST API
export async function executeCallTransfer(twilioCallSid: string, transferPhoneNumber: string): Promise<void> {
  try {
    logger.info(`📞 [Twilio Transfer] Initiating transfer for CallSid: ${twilioCallSid}`);
    logger.info(`   Transfer to: [redacted]`);

    const twilioClient = await getTwilioClient();

    // Get the original call to retrieve the caller's number
    const call = await twilioClient.calls(twilioCallSid).fetch();
    const fromNumber = call.from; // The original caller's number (shows on transfer recipient's phone)

    // Create TwiML to transfer the call
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Please hold while I transfer your call.</Say>
  <Dial callerId="${fromNumber}">
    <Number>${transferPhoneNumber}</Number>
  </Dial>
</Response>`;

    logger.info(`📋 [Twilio Transfer] TwiML:`, twiml);

    // Update the active call with the transfer TwiML
    await twilioClient.calls(twilioCallSid).update({
      twiml: twiml
    });

    logger.info(`✅ [Twilio Transfer] Call transfer initiated successfully`);
    logger.info(`   The caller will now be connected to [redacted]`);
  } catch (error: any) {
    logger.error(`❌ [Twilio Transfer] Failed to transfer call:`, error);
    throw new Error(`Twilio transfer failed: ${error.message}`);
  }
}
