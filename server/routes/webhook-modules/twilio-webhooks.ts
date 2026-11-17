'use strict';
/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
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
import { calls, phoneNumbers, incomingConnections, agents } from '../../../shared/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import WebSocket from 'ws';
import { getTwilioClient } from '../../services/twilio-connector';
import { getDomain } from '../../utils/domain';
import { withStreamToken, redactStreamToken } from '../../utils/stream-token.ts';
import twilio from 'twilio';
import { logger } from '../../utils/logger';
import { formatAndSaveTranscript, updateCampaignStats, deductCallCreditsForElevenLabs } from '../webhooks/helpers';
import { enforceWebhookRateLimit, activeConnections } from './webhook-shared';
import { endTwilioCall } from './twilio-call-helpers';
import { initializeElevenLabsConnection } from './elevenlabs-stream';

// Handle incoming calls to Twilio numbers (for incoming agents)
export async function handleIncomingCallWebhook(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  try {
    logger.info(`📞 [Incoming Call] Received incoming call from Twilio`);
    logger.info(`   Body:`);

    const { To, From, CallSid, CallerId } = req.body;

    if (!To || !From || !CallSid) {
      logger.error(`❌ [Incoming Call] Missing required parameters`);
      return res.status(400).send('Missing required parameters');
    }

    logger.info(`📞 [Incoming Call] From: ${From}, To: [redacted], CallSid: ${CallSid}`);

    // Look up the phone number and its incoming connection
    const phoneNumber = await db
      .select({
        id: phoneNumbers.id,
        userId: phoneNumbers.userId,
        phoneNumber: phoneNumbers.phoneNumber,
      })
      .from(phoneNumbers)
      .where(eq(phoneNumbers.phoneNumber, To))
      .limit(1);

    if (!phoneNumber || phoneNumber.length === 0) {
      logger.error(`❌ [Incoming Call] REJECTED - Phone number ${To} not found in database`);
      logger.error(`   🚨 [Security Audit] Unauthorized incoming call attempt: From=${From}, To=${To}, CallSid=${CallSid}`);
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      // Use reject() to minimize cost - caller hears busy/disconnect, no billing
      response.reject({ reason: 'rejected' });
      res.type('text/xml');
      return res.send(response.toString());
    }

    const phone = phoneNumber[0];

    // Look up the incoming connection for this phone number
    const connection = await db
      .select({
        id: incomingConnections.id,
        agentId: incomingConnections.agentId,
      })
      .from(incomingConnections)
      .where(eq(incomingConnections.phoneNumberId, phone.id))
      .limit(1);

    if (!connection || connection.length === 0) {
      logger.error(`❌ [Incoming Call] REJECTED - Phone number ${To} has no incoming connection configured`);
      logger.error(`   🚨 [Security Audit] Incoming call to unconfigured number: From=${From}, To=${To}, CallSid=${CallSid}`);
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      // Use reject() to minimize cost - caller hears busy/disconnect, no billing
      response.reject({ reason: 'rejected' });
      res.type('text/xml');
      return res.send(response.toString());
    }

    const incomingConnection = connection[0];

    // Verify connection belongs to the same user as the phone number (security check)
    const connectionDetails = await db
      .select({
        userId: incomingConnections.userId,
      })
      .from(incomingConnections)
      .where(eq(incomingConnections.id, incomingConnection.id))
      .limit(1);

    if (!connectionDetails.length || connectionDetails[0].userId !== phone.userId) {
      logger.error(`❌ [Incoming Call] REJECTED - Connection ownership mismatch for ${To}`);
      logger.error(`   🚨 [Security Audit] Ownership mismatch: From=${From}, To=${To}, CallSid=${CallSid}`);
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      // Use reject() to minimize cost
      response.reject({ reason: 'rejected' });
      res.type('text/xml');
      return res.send(response.toString());
    }

    // Fetch the agent details (type='incoming')
    const agent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, incomingConnection.agentId), eq(agents.type, 'incoming')))
      .limit(1);

    if (!agent || agent.length === 0) {
      logger.error(`❌ [Incoming Call] REJECTED - Agent ${incomingConnection.agentId} not found or wrong type for ${To}`);
      logger.error(`   🚨 [Security Audit] Missing agent: From=${From}, To=${To}, CallSid=${CallSid}`);
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      // Use reject() to minimize cost
      response.reject({ reason: 'rejected' });
      res.type('text/xml');
      return res.send(response.toString());
    }

    const incomingAgent = agent[0];

    // NATIVE ELEVENLABS INTEGRATION:
    // This webhook should NOT be called for numbers with incoming connections.
    // Twilio should route directly to ElevenLabs (https://api.elevenlabs.io/twilio/inbound_call).
    // If we reach here, it means Twilio webhook is misconfigured for this number.

    logger.info(`⚠️  [Incoming Call] Call reached our server but should be handled by ElevenLabs natively`);
    logger.info(`   This indicates Twilio webhook is misconfigured for phone number [redacted]`);
    logger.info(`   Expected: Twilio should route to https://api.elevenlabs.io/twilio/inbound_call`);
    logger.info(`   Fix: Delete and recreate the incoming connection to resync Twilio webhook`);

    // Return a helpful message to the caller
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say('We are experiencing a temporary configuration issue. Please call back in a moment.');
    res.type('text/xml');
    return res.send(response.toString());
  } catch (error) {
    logger.error('❌ [Incoming Call] Error:', error);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say('An error occurred. Please try again later.');
    res.type('text/xml');
    res.send(response.toString());
  }
}

// Handle outbound campaign calls
export async function handleTwilioVoiceWebhook(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  try {
    logger.info(`🎙️ [Voice Webhook] Received request from Twilio`);
    logger.info(`   Query params:`, req.query);
    logger.info(`   Body:`);

    const { callId, agentId, contactName, flowId, executionId } = req.query;

    if (!callId || !agentId) {
      logger.error(`❌ [Voice Webhook] Missing required parameters - callId: ${callId}, agentId: ${agentId}`);
      return res.status(400).send('Missing required parameters');
    }

    logger.info(`✅ [Voice Webhook] Call ${callId} answered, agent: ${agentId}, contact: ${contactName || 'N/A'}`);
    if (flowId) {
      logger.info(`   Flow ID: ${flowId}, Execution ID: ${executionId}`);
    }

    await db
      .update(calls)
      .set({ status: 'answered' })
      .where(eq(calls.id, callId as string));

    const domain = getDomain(req.headers.host as string);
    const streamUrl = withStreamToken(`wss://${domain}/api/webhooks/twilio/stream`, {
      callId: callId as string,
      agentId: agentId as string,
    });

    logger.info(`📞 [Voice Webhook] Creating TwiML with stream URL: [redacted]`);
    logger.info(`   Parameters: callId=${callId}, agentId=${agentId}, contactName=${contactName || 'N/A'}`);

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const connect = response.connect();

    const stream = connect.stream({ url: streamUrl });
    stream.parameter({ name: 'callId', value: callId as string });
    stream.parameter({ name: 'agentId', value: agentId as string });
    if (contactName) {
      stream.parameter({ name: 'contactName', value: contactName as string });
    }
    // Pass flow execution context to Media Streams handler
    if (flowId) {
      stream.parameter({ name: 'flowId', value: flowId as string });
    }
    if (executionId) {
      stream.parameter({ name: 'executionId', value: executionId as string });
    }

    const twimlString = response.toString();
    logger.info(`📄 [Voice Webhook] Generated TwiML:\n${redactStreamToken(twimlString)}`);

    res.type('text/xml');
    res.send(twimlString);
  } catch (error) {
    logger.error('Voice webhook error:', error);
    res.status(500).send('Internal server error');
  }
}

export async function handleTwilioStatusWebhook(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  try {
    logger.info(`📊 [Status Webhook] Received status update from Twilio`);
    logger.info(`   Query params:`, JSON.stringify(req.query));
    logger.info(`   Body:`);
    logger.info(`   CallSid: ${req.body.CallSid}, Status: ${req.body.CallStatus}`);

    const { callId: queryCallId } = req.query;
    const {
      CallStatus,
      CallDuration,
      RecordingUrl,
      To,
      From,
      CallSid,
      Direction,
      ForwardedFrom,
      CallerName
    } = req.body;

    let callId = queryCallId as string | undefined;

    if (!callId && CallSid) {
      const [matchedCall] = await db
        .select({ id: calls.id })
        .from(calls)
        .where(eq(calls.twilioSid, CallSid))
        .limit(1);

      if (matchedCall) {
        callId = matchedCall.id;
        logger.info(`[Status Webhook] Resolved call by CallSid ${CallSid} -> ${callId}`);
      } else {
        logger.warn(`[Status Webhook] No match found for CallSid ${CallSid} in calls table`);
      }
    }

    if (!callId) {
      // For SIP-based or ElevenLabs incoming calls, the call record may not exist in the calls table yet
      // (ElevenLabs webhook creates it later) or it may be in the sip_calls table.
      // Check sip_calls table as fallback before giving up.
      if (CallSid) {
        try {
          const sipCallResult = await db.execute(sql`
            SELECT id, status FROM sip_calls 
            WHERE external_call_id = ${CallSid} 
            OR elevenlabs_conversation_id = ${CallSid}
            LIMIT 1
          `);
          const sipCall = sipCallResult.rows[0] as any;

          if (sipCall) {
            logger.info(`[Status Webhook] Found SIP call by CallSid ${CallSid} -> ${sipCall.id}`);

            const sipStatusMap: Record<string, string> = {
              'initiated': 'initiated',
              'ringing': 'ringing',
              'in-progress': 'in-progress',
              'completed': 'completed',
              'busy': 'failed',
              'failed': 'failed',
              'no-answer': 'failed'
            };
            const sipStatus = sipStatusMap[CallStatus] || CallStatus;

            const terminalStatuses = ['completed', 'failed'];
            if (!terminalStatuses.includes(sipCall.status)) {
              const recUrl = RecordingUrl ? (RecordingUrl.endsWith('.mp3') ? RecordingUrl : `${RecordingUrl}.mp3`) : null;
              await db.execute(sql`
                UPDATE sip_calls SET 
                  status = ${sipStatus},
                  duration_seconds = COALESCE(${CallDuration ? parseInt(CallDuration, 10) : null}::int, duration_seconds),
                  answered_at = CASE WHEN ${CallStatus} = 'in-progress' AND answered_at IS NULL THEN NOW() ELSE answered_at END,
                  ended_at = CASE WHEN ${CallStatus} = 'completed' THEN NOW() ELSE ended_at END,
                  recording_url = COALESCE(${recUrl}, recording_url),
                  updated_at = NOW()
                WHERE id = ${sipCall.id}
              `);
              logger.info(`✅ [Status Webhook] SIP call ${sipCall.id} status updated: ${CallStatus}`);
            } else {
              logger.warn(`[Status Webhook] SIP call ${sipCall.id} already in terminal status '${sipCall.status}' - skipping`);
            }

            return res.sendStatus(200);
          }
        } catch (sipLookupError: any) {
          logger.warn(`[Status Webhook] SIP calls lookup error (non-fatal): ${sipLookupError.message}`);
        }
      }

      // For ElevenLabs incoming calls, the call record may not exist yet 
      // (Twilio status webhook arrives before ElevenLabs post-call webhook creates the record).
      // Return 200 to prevent Twilio from retrying - the ElevenLabs webhook will handle call creation.
      logger.warn(`[Status Webhook] Could not resolve call - no callId param and no matching CallSid ${CallSid || 'N/A'}. Returning 200 (call record may be created later by ElevenLabs webhook).`);
      return res.sendStatus(200);
    }

    const statusMap: Record<string, string> = {
      'initiated': 'initiated',
      'ringing': 'ringing',
      'in-progress': 'in-progress',
      'completed': 'completed',
      'busy': 'busy',
      'failed': 'failed',
      'no-answer': 'no-answer'
    };

    const status = statusMap[CallStatus] || CallStatus;

    // Build metadata object with call information
    const metadata: any = {
      twilioCallSid: CallSid,
      to: To,
      from: From,
      direction: Direction,
    };

    if (ForwardedFrom) metadata.forwardedFrom = ForwardedFrom;
    if (CallerName) metadata.callerName = CallerName;

    const updateData: any = {
      status,
      metadata
    };

    if (CallSid && !queryCallId) {
      updateData.twilioSid = CallSid;
    }

    // Save recording URL if provided in status webhook
    if (RecordingUrl) {
      // Append .mp3 for direct audio playback access
      updateData.recordingUrl = RecordingUrl.endsWith('.mp3') ? RecordingUrl : `${RecordingUrl}.mp3`;
      logger.info(`📼 [Status Webhook] Recording URL captured: [redacted]`);
    }

    // Save phone numbers from Twilio for incoming calls
    if (To) {
      updateData.toNumber = To;
    }
    if (From) {
      updateData.fromNumber = From;
    }

    if (CallStatus === 'completed') {
      updateData.endedAt = new Date();
      if (CallDuration) {
        updateData.duration = parseInt(CallDuration, 10);
      }
    }

    await db
      .update(calls)
      .set(updateData)
      .where(eq(calls.id, callId as string));

    logger.info(`✅ [Status Webhook] Call ${callId} status updated: ${CallStatus}`);

    if (CallStatus === 'completed' && CallDuration) {
      const creditResult = await deductCallCreditsForElevenLabs(callId as string, parseInt(CallDuration, 10));

      if (!creditResult.success && !creditResult.alreadyDeducted) {
        logger.error(`❌ [Status Webhook] Credit deduction failed for call ${callId}: ${creditResult.error}`);

        // Mark call as failed due to insufficient credits
        await db.update(calls)
          .set({
            status: 'failed',
            metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ creditDeductionFailed: true, creditError: creditResult.error })}`
          })
          .where(eq(calls.id, callId as string));

        logger.warn(`⚠️ [Status Webhook] Call ${callId} marked as failed due to credit deduction failure`);

        // CRITICAL: Stop all downstream processing when credits fail
        return res.status(200).json({
          success: false,
          error: 'Credit deduction failed',
          callId
        });
      }
    }

    // AUTOMATIC RECORDING RECOVERY: If call completed/answered but no recording URL, fetch from Twilio
    if (['completed', 'answered'].includes(CallStatus)) {
      try {
        // Get the call record to check if it has a recording URL and Twilio SID
        const [callRecord] = await db
          .select()
          .from(calls)
          .where(eq(calls.id, callId as string))
          .limit(1);

        if (callRecord && callRecord.twilioSid && !callRecord.recordingUrl) {
          logger.info(`🎙️ [Auto Recovery] Call ${callId} completed but no recording URL. Fetching from Twilio...`);

          const twilioClient = await getTwilioClient();

          try {
            // Fetch recordings for this call from Twilio
            const recordings = await twilioClient.recordings.list({
              callSid: callRecord.twilioSid,
              limit: 1
            });

            if (recordings.length > 0) {
              const recording = recordings[0];
              const recordingUrl = `https://api.twilio.com${recording.uri.replace('.json', '')}`;

              logger.info(`✅ [Auto Recovery] Found recording: ${recordingUrl}`);

              // Update call with recording URL
              await db
                .update(calls)
                .set({
                  recordingUrl,
                  duration: recording.duration ? parseInt(recording.duration, 10) : callRecord.duration
                })
                .where(eq(calls.id, callId as string));

              logger.info(`✅ [Auto Recovery] Recording automatically recovered for call ${callId}`);
            } else {
              logger.info(`⚠️ [Auto Recovery] No recording found in Twilio for call ${callId} (SID: ${callRecord.twilioSid})`);
            }
          } catch (recordingError: any) {
            logger.error(`❌ [Auto Recovery] Failed to fetch recording from Twilio:`);
          }
        } else if (callRecord && !callRecord.twilioSid) {
          logger.warn(`⚠️ [Auto Recovery] Call ${callId} has no Twilio SID - cannot fetch recording`);
        }
      } catch (error: any) {
        logger.error(`❌ [Auto Recovery] Error during automatic recording recovery:`, error.message);
      }
    }

    if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
      await updateCampaignStats(callId as string, CallStatus);

      const ws = activeConnections.get(callId as string);
      if (ws) {
        ws.close();
        activeConnections.delete(callId as string);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    logger.error('Status webhook error:', error);
    res.status(500).send('Internal server error');
  }
}

export async function handleTwilioRecordingWebhook(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  try {
    logger.info(`📼 [Recording Webhook] Received request`);
    logger.info(`   Query params:`, req.query);
    logger.info(`   Body:`);

    const { callId } = req.query;
    const { RecordingUrl, RecordingDuration, RecordingSid, RecordingStatus } = req.body;

    if (!callId) {
      logger.error(`❌ [Recording Webhook] Missing call ID in query params`);
      // Still return 200 to prevent Twilio retries
      return res.sendStatus(200);
    }

    // Twilio sends multiple callbacks for different recording statuses
    // Only process when status is 'completed' and we have a RecordingUrl
    if (RecordingStatus !== 'completed') {
      logger.info(`⏳ [Recording Webhook] Status: ${RecordingStatus} (waiting for 'completed')`);
      return res.sendStatus(200);
    }

    if (!RecordingUrl) {
      logger.error(`❌ [Recording Webhook] Status is 'completed' but RecordingUrl is missing`);
      // Still return 200 to prevent Twilio retries
      return res.sendStatus(200);
    }

    logger.info(`💾 [Recording Webhook] Updating call ${callId}`);
    logger.info(`   RecordingUrl: ${RecordingUrl}`);
    logger.info(`   RecordingSid: ${RecordingSid}`);
    logger.info(`   RecordingDuration: ${RecordingDuration}`);
    logger.info(`   RecordingStatus: ${RecordingStatus}`);

    await db
      .update(calls)
      .set({
        recordingUrl: RecordingUrl,
        duration: RecordingDuration ? parseInt(RecordingDuration, 10) : undefined
      })
      .where(eq(calls.id, callId as string));

    logger.info(`✅ [Recording Webhook] Successfully saved recording for call ${callId}`);

    res.sendStatus(200);
  } catch (error) {
    logger.error('❌ [Recording Webhook] Error:', error);
    // Always return 200 even on error to prevent Twilio retries
    res.sendStatus(200);
  }
}

export async function handleTwilioStreamWebSocket(ws: WebSocket, req: Request) {
  logger.info(`[Stream] WebSocket connection established, waiting for Twilio start message...`);

  let callId: string | null = null;
  let agentId: string | null = null;
  let streamSid: string | null = null;
  let twilioCallSid: string | null = null;
  let elevenLabsWs: WebSocket | null = null;
  let mediaPacketCount = 0;
  const silenceTimerRef = { current: null as NodeJS.Timeout | null };

  // Flow execution context (optional)
  let flowId: string | null = null;
  let executionId: string | null = null;
  let flowBridge: any | null = null; // FlowExecutionBridge instance
  let fromPhoneNumber: string | null = null; // Originating phone number for transfers

  const conversationHistory: Array<{ role: 'user' | 'agent', text: string, timestamp: Date }> = [];

  const endCall = async (reason: string) => {
    // Clear any pending silence timer to prevent stale timeouts
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    await endTwilioCall(twilioCallSid, reason);
  };

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          twilioCallSid = data.start.callSid;
          const customParams = data.start.customParameters || {};
          callId = customParams.callId;
          agentId = customParams.agentId;
          const contactName = customParams.contactName;
          flowId = customParams.flowId || null;
          executionId = customParams.executionId || null;
          fromPhoneNumber = customParams.fromPhone || null;

          logger.info(`✅ [Twilio] Media stream started`);
          logger.info(`   StreamSid: ${streamSid}`);
          logger.info(`   Twilio CallSid: ${twilioCallSid}`);
          logger.info(`   CallId: ${callId}`);
          logger.info(`   AgentId: ${agentId}`);
          logger.info(`   Contact Name: ${contactName || 'N/A'}`);
          logger.info(`   From Phone: [redacted]`);
          if (flowId) {
            logger.info(`   🔀 Flow Mode Enabled`);
            logger.info(`   Flow ID: ${flowId}`);
            logger.info(`   Execution ID: ${executionId}`);
          }
          logger.info(`   Custom parameters:`, JSON.stringify(customParams, null, 2));

          if (!callId || !agentId) {
            logger.error('[Stream] Missing required parameters in start message');
            ws.close(1002, 'Missing parameters');
            return;
          }

          // Start call recording via Twilio REST API
          // Note: Recording cannot be enabled via TwiML when using <Connect><Stream>
          if (twilioCallSid) {
            try {
              const twilioClient = await getTwilioClient();
              const domain = getDomain(req.headers.host as string);
              const recordingCallbackUrl = `${domain}/api/webhooks/twilio/recording?callId=${callId}`;

              logger.info(`📼 [Recording] Starting recording for call ${twilioCallSid}`);
              logger.info(`   Recording callback URL: ${recordingCallbackUrl}`);

              await twilioClient.calls(twilioCallSid)
                .recordings
                .create({
                  recordingStatusCallback: recordingCallbackUrl,
                  recordingStatusCallbackMethod: 'POST',
                  recordingStatusCallbackEvent: ['completed'],
                });

              logger.info(`✅ [Recording] Recording started successfully`);
            } catch (recordingError) {
              // Don't fail the call if recording fails - just log the error
              logger.error(`❌ [Recording] Failed to start recording:`);
            }
          } else {
            logger.warn(`⚠️ [Recording] Cannot start recording - no Twilio CallSid available`);
          }

          try {
            activeConnections.set(callId, ws);

            // Resolve caller's phone so we can inject it as contact_phone dynamic variable.
            // This prevents the agent from asking the caller to repeat their phone number
            // during form collection. Prefer explicit custom param, fall back to call record.
            let callerPhone: string | undefined = customParams.contactPhone || undefined;
            if (!callerPhone) {
              try {
                const callRecord = await db
                  .select({ phoneNumber: calls.phoneNumber })
                  .from(calls)
                  .where(eq(calls.id, callId))
                  .limit(1);
                if (callRecord.length > 0 && callRecord[0].phoneNumber) {
                  callerPhone = callRecord[0].phoneNumber;
                  logger.info(`[Stream] 📞 Resolved caller phone from call record: [redacted]`);
                }
              } catch (phoneErr) {
                logger.warn(`[Stream] ⚠️ Could not resolve caller phone for dynamic variable:`);
              }
            } else {
              logger.info(`[Stream] 📞 Using caller phone from custom params: [redacted]`);
            }

            // Flow Agents now execute entirely through ElevenLabs with compiled workflows
            // No need for FlowExecutionBridge - ElevenLabs handles the workflow execution
            if (flowId && executionId) {
              logger.info(`🔄 [Flow Agent] Using ElevenLabs workflow execution`);
              logger.info(`   Flow ID: ${flowId}`);
              logger.info(`   Execution ID: ${executionId}`);
            }

            elevenLabsWs = await initializeElevenLabsConnection(
              agentId,
              callId,
              contactName,
              callerPhone,
              streamSid,
              ws,
              conversationHistory,
              silenceTimerRef,
              endCall,
              null  // Flow bridge no longer used - ElevenLabs handles workflow execution
            );
          } catch (error) {
            logger.error(`[Stream] Error initializing ElevenLabs connection:`, error);
            ws.close();
          }
          break;

        case 'media':
          mediaPacketCount++;
          if (mediaPacketCount % 50 === 0) {
            logger.info(`🎤 [Twilio→ElevenLabs] Sent ${mediaPacketCount} audio packets`);
          }

          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN && data.media?.payload) {
            const audioMessage = {
              user_audio_chunk: data.media.payload,
            };
            elevenLabsWs.send(JSON.stringify(audioMessage));
          }
          break;

        case 'stop':
          logger.info(`🛑 [Twilio] Media stream stopped for call ${callId}`);
          logger.info(`[Twilio] Total media packets received: ${mediaPacketCount}`);
          if (elevenLabsWs) {
            elevenLabsWs.close();
          }
          break;

        default:
          logger.info(`❓ [Twilio] Received unhandled event: ${data.event}`);
      }
    } catch (error) {
      logger.error(`❌ [Twilio] Error processing message for call ${callId}:`, error);
    }
  });

  ws.on('close', async () => {
    logger.info(`[Twilio] WebSocket closed for call ${callId}`);
    logger.info(`[Twilio] Conversation history length: ${conversationHistory.length}`);
    logger.info(`[Twilio] CallId present: ${!!callId}`);

    await formatAndSaveTranscript(callId, conversationHistory);

    if (elevenLabsWs) {
      elevenLabsWs.close();
    }
    if (callId) {
      activeConnections.delete(callId);
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }
  });

  ws.on('error', (error) => {
    logger.error(`[Twilio] WebSocket error for call ${callId}:`, error);
    if (elevenLabsWs) {
      elevenLabsWs.close();
    }
  });
}
