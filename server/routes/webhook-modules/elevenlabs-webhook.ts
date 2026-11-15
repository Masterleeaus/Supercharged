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
import { calls, agents } from '../../../shared/schema';
import { eq, and, or } from 'drizzle-orm';
import WebSocket from 'ws';
import { logger } from '../../utils/logger';
import { enforceWebhookRateLimit } from './webhook-shared';
import { verifyWithAllSecrets } from './elevenlabs-verify';
import type { ElevenLabsWebhookCtx } from './elevenlabs-context';
import { handlePostCallAudioWebhook } from './elevenlabs-post-call-audio';
import { handleCallInitiationFailureWebhook } from './elevenlabs-call-initiation-failure';
import { matchCallRecordFallback, updateFlowExecutionToRunning } from './elevenlabs-call-match';
import { handleSipCase0 } from './elevenlabs-sip-native';
import { handleSipFallback } from './elevenlabs-sip-fallback';
import { handleCampaignFallbackCreate, handleIncomingCallCreate } from './elevenlabs-native-create';
import { handleFailedCallTracking } from './elevenlabs-failed-call';
import { processPostCallTranscription } from './elevenlabs-post-call-sync';

/**
 * Handle ElevenLabs post-call webhook events
 * Receives notifications when calls complete via ElevenLabs native Twilio integration
 * 
 * Webhook types (per ElevenLabs docs):
 * - post_call_transcription: Contains full conversation data including transcripts, analysis results
 * - post_call_audio: Contains minimal data with base64-encoded audio
 * - call_initiation_failure: Contains information about failed call initiation attempts
 * 
 * Security: Verifies HMAC signature by trying all credential secrets
 * Multi-key pool: Each ElevenLabs API key has its own webhook secret, we verify against all
 * This approach is secure because we verify BEFORE trusting any body data
 */
export async function handleElevenLabsWebhook(req: Request, res: Response) {
  if (!(await enforceWebhookRateLimit(req, res))) return;
  try {
    logger.info(`📞 [ElevenLabs Webhook] Received event`);

    // Get the raw body as string for signature verification
    // Must use the actual raw body buffer, not re-stringified JSON, for HMAC to match
    const rawBody = req.rawBody ? Buffer.from(req.rawBody as Uint8Array).toString() : JSON.stringify(req.body);
    const signatureHeader = req.headers['elevenlabs-signature'] as string | undefined;

    // Debug: Log signature header format
    logger.info(`   Signature header present: ${!!signatureHeader}`);
    if (signatureHeader) {
      logger.info(`   Signature header value: [redacted]...`);
    }

    // Secure verification: Try all credential secrets until one matches
    // This way we don't trust the body data until AFTER verification succeeds
    const verification = await verifyWithAllSecrets(rawBody, signatureHeader);

    // Fail closed. Unsigned, badly signed, stale, or no-secret-configured webhooks are rejected
    // in every environment. The former SIP-metadata and NODE_ENV=development bypasses are removed.
    if (!verification.verified) {
      logger.warn(`⚠️ [ElevenLabs Webhook] Signature verification failed: ${verification.error}`);
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    logger.info(`   ✅ Signature verified`);

    // Parse the webhook body according to ElevenLabs format
    // Standard format: { type: string, data: object, event_timestamp: number }
    // Legacy audio format: { audio: "base64..." } (WebSocket streaming webhook)
    const { type, data, event_timestamp, audio } = req.body;

    // DEBUG: Log the entire webhook body structure (keys only for sensitive data)
    const bodyKeys = Object.keys(req.body);
    logger.info(`   Body structure: { ${bodyKeys.join(', ')} }`);
    logger.info(`   Has 'type': ${!!type}`);
    logger.info(`   Has 'data': ${!!data}`);
    logger.info(`   Has 'audio': ${!!audio}`);

    // Handle legacy audio-only webhook format (WebSocket streaming)
    if (audio && !type) {
      logger.warn(`📞 [ElevenLabs Webhook] Received legacy audio-only webhook - skipping`);
      logger.info(`   Audio data size: ~${Math.round((audio as string).length / 1024)}KB`);
      // These are streaming audio chunks, not post-call data
      return res.sendStatus(200);
    }

    // Log webhook type
    logger.info(`   Webhook type: ${type || 'undefined'}`);
    logger.info(`   Event timestamp: ${event_timestamp || 'N/A'}`);

    if (!type) {
      logger.warn(`⚠️ [ElevenLabs Webhook] Unknown webhook format - no 'type' field`);
      logger.info(`   Full body keys: ${JSON.stringify(bodyKeys)}`);
      // Don't return 400 - just log and acknowledge to prevent retries
      return res.sendStatus(200);
    }

    // Handle post_call_audio webhooks (contains recording URL)
    // IMPORTANT: ElevenLabs recording URLs expire quickly, so we DON'T store them
    // Instead, we fetch ElevenLabs audio on-demand during playback
    // We only store Twilio recording URLs (stable/permanent)
    if (type === 'post_call_audio') {
      return await handlePostCallAudioWebhook(res, data);
    }

    // Handle call_initiation_failure webhooks
    if (type === 'call_initiation_failure') {
      return await handleCallInitiationFailureWebhook(res, data);
    }


    // Handle post_call_transcription webhooks (main call completion data)
    // Support both standard 'post_call_transcription' and OpenTelemetry-enabled 'post_call_transcription_otel' formats
    if (type !== 'post_call_transcription' && type !== 'post_call_transcription_otel') {
      logger.info(`⚠️ [ElevenLabs Webhook] Unknown webhook type: ${type}`);
      return res.sendStatus(200);
    }

    // Extract data from post_call_transcription webhook
    const {
      agent_id,
      conversation_id,
      status,
      transcript: webhookTranscript,
      metadata,
      analysis
    } = data || {};

    const customerPhone = data?.user_id || data?.userId || null;

    if (!conversation_id) {
      logger.warn(`⚠️ [ElevenLabs Webhook] Missing conversation_id in data`);
      return res.status(400).json({ error: 'Missing conversation_id' });
    }

    logger.info(`   Conversation ID: ${conversation_id}`);
    logger.info(`   Agent ID: ${agent_id || 'N/A'}`);
    logger.info(`   Status: ${status || 'N/A'}`);

    // COMPREHENSIVE LOGGING: Log all webhook data for debugging
    logger.info(`📋 [ElevenLabs Webhook] Full webhook data structure:`);
    logger.info(`   metadata keys: ${metadata ? Object.keys(metadata).join(', ') : 'N/A'}`);
    if (metadata) {
      // Log phone_call object (where phone numbers are nested for telephony calls)
      if (metadata.phone_call) {
        logger.info(`   metadata.phone_call keys: ${Object.keys(metadata.phone_call).join(', ')}`);
        logger.info(`   metadata.phone_call.from: [redacted]`);
        logger.info(`   metadata.phone_call.to: [redacted]`);
        logger.info(`   metadata.phone_call.call_sid: ${metadata.phone_call.call_sid || metadata.phone_call.twilio_call_sid || 'N/A'}`);
      } else {
        logger.info(`   metadata.phone_call: N/A (not a phone call)`);
      }
      // Log batch_call object if present
      if (metadata.batch_call) {
        logger.info(`   metadata.batch_call keys: ${Object.keys(metadata.batch_call).join(', ')}`);
        logger.info(`   metadata.batch_call.batch_call_id: ${metadata.batch_call.batch_call_id || 'N/A'}`);
        logger.info(`   metadata.batch_call.batch_call_recipient_id: ${metadata.batch_call.batch_call_recipient_id || 'N/A'}`);
      }
      // Log external_number if present (used in batch calls)
      if (metadata.phone_call?.external_number) {
        logger.info(`   metadata.phone_call.external_number: [redacted]`);
      }
      // Log direct fields (fallback)
      logger.info(`   metadata.from_number (direct): ${metadata.from_number || 'N/A'}`);
      logger.info(`   metadata.to_number (direct): ${metadata.to_number || 'N/A'}`);
      logger.info(`   metadata.call_duration_secs: ${metadata.call_duration_secs || 'N/A'}`);
      logger.info(`   metadata.termination_reason: ${metadata.termination_reason || 'N/A'}`);
      // Log error and warnings for debugging failed calls
      if (metadata.error) {
        logger.error(`   ❌ metadata.error: ${JSON.stringify(metadata.error)}`);
      }
      if (metadata.warnings && metadata.warnings.length > 0) {
        logger.info(`   ⚠️ metadata.warnings: ${JSON.stringify(metadata.warnings)}`);
      }
    }
    logger.info(`   analysis keys: ${analysis ? Object.keys(analysis).join(', ') : 'N/A'}`);
    if (analysis) {
      logger.info(`   analysis.call_successful: ${analysis.call_successful || 'N/A'}`);
      logger.info(`   analysis.transcript_summary: ${analysis.transcript_summary ? 'present (' + analysis.transcript_summary.length + ' chars)' : 'N/A'}`);
    }
    logger.info(`   transcript entries: ${webhookTranscript ? webhookTranscript.length : 0}`);

    // EXTRACT PHONE NUMBERS: Check all possible locations
    // Priority: phone_call object > batch_call object > direct metadata fields
    // For SIP calls: agent_number = your SIP phone, external_number = caller/recipient
    // Direction matters: inbound (From=external, To=agent), outbound (From=agent, To=external)
    const callDirection = metadata?.phone_call?.direction;
    const agentNumber = metadata?.phone_call?.agent_number;
    const externalNumber = metadata?.phone_call?.external_number;

    // Determine From/To based on direction for SIP calls with agent_number/external_number
    let extractedFromNumber: string | null = null;
    let extractedToNumber: string | null = null;

    if (callDirection === 'inbound' && (agentNumber || externalNumber)) {
      // Inbound: caller is external_number, recipient is agent_number
      extractedFromNumber = externalNumber || metadata?.phone_call?.from || metadata?.phone_call?.from_number || null;
      extractedToNumber = agentNumber || metadata?.phone_call?.to || metadata?.phone_call?.to_number || null;
    } else if (callDirection === 'outbound' && (agentNumber || externalNumber)) {
      // Outbound: caller is agent_number, recipient is external_number
      extractedFromNumber = agentNumber || metadata?.phone_call?.from || metadata?.phone_call?.from_number || null;
      extractedToNumber = externalNumber || metadata?.phone_call?.to || metadata?.phone_call?.to_number || null;
    } else {
      // Fallback: Use explicit from/to fields, batch_call data, or Twilio metadata
      // Also check fromNumber/twilioFrom which the system itself writes at call creation time
      extractedFromNumber =
        metadata?.phone_call?.from ||
        metadata?.phone_call?.from_number ||
        metadata?.batch_call?.from ||
        metadata?.from_number ||
        metadata?.fromNumber ||
        metadata?.twilioFrom ||
        null;
      extractedToNumber =
        metadata?.phone_call?.to ||
        metadata?.phone_call?.to_number ||
        metadata?.batch_call?.to ||
        metadata?.to_number ||
        metadata?.toNumber ||
        metadata?.twilioTo ||
        null;
    }
    const extractedCallSid =
      metadata?.phone_call?.call_sid ||
      metadata?.phone_call?.twilio_call_sid ||
      metadata?.call_sid ||
      null;

    logger.info(`📱 [ElevenLabs Webhook] Extracted phone data (direction: ${callDirection || 'unknown'}):`);
    logger.info(`   From: ${extractedFromNumber || 'N/A'} (caller)`);
    logger.info(`   To: ${extractedToNumber || 'N/A'} (recipient)`);
    logger.info(`   Agent Number: [redacted], External Number: ${externalNumber || 'N/A'}`);
    logger.info(`   CallSid: ${extractedCallSid || 'N/A'}`);

    // Find the call record by ElevenLabs conversation ID
    const [callRecord] = await db
      .select()
      .from(calls)
      .where(eq(calls.elevenLabsConversationId, conversation_id))
      .limit(1);

    const ctx: ElevenLabsWebhookCtx = {
      type,
      data,
      agent_id,
      conversation_id,
      status,
      webhookTranscript,
      metadata,
      analysis,
      customerPhone,
      callDirection,
      agentNumber,
      externalNumber,
      extractedFromNumber,
      extractedToNumber,
      extractedCallSid,
      callRecord,
    };

    // If no record found by conversation_id, try matching by phone number + agent for batch calls
    // Batch calls are pre-created with status='pending' and matching phone numbers
    // NOTE: Campaign scheduler may mark calls as 'failed' before this webhook arrives,
    // so we also search for 'failed' and 'in_progress' statuses
    await matchCallRecordFallback(ctx);
    await updateFlowExecutionToRunning(ctx);

    // If no call record exists, this might be an incoming call via ElevenLabs native integration
    // We need to create a call record for it - process the webhook data directly
    if (!ctx.callRecord) {
      logger.info(`📞 [ElevenLabs Webhook] No existing call record - checking if this is a native incoming call or outbound campaign call`);

      try {
        // Find the agent by ElevenLabs agent ID
        if (agent_id) {
          const [agent] = await db
            .select()
            .from(agents)
            .where(eq(agents.elevenLabsAgentId, agent_id))
            .limit(1);

          const sipCase0Result = await handleSipCase0(res, ctx, agent);
          if (sipCase0Result !== undefined) return sipCase0Result;
          const sipFallbackResult = await handleSipFallback(res, ctx, agent);
          if (sipFallbackResult !== undefined) return sipFallbackResult;
          const campaignCreateResult = await handleCampaignFallbackCreate(res, ctx, agent);
          if (campaignCreateResult !== undefined) return campaignCreateResult;
          const incomingCreateResult = await handleIncomingCallCreate(res, ctx, agent);
          if (incomingCreateResult !== undefined) return incomingCreateResult;
        }
      } catch (createError: any) {
        logger.error(`❌ [ElevenLabs Webhook] Error creating incoming call record:`, createError);
      }
    }

    const failedCallResult = await handleFailedCallTracking(res, ctx);
    if (failedCallResult !== undefined) return failedCallResult;

    if (!ctx.callRecord) {
      logger.warn(`⚠️ [ElevenLabs Webhook] No call record found or created — DIAGNOSTIC SUMMARY:`);
      logger.warn(`   conversation_id: ${conversation_id}`);
      logger.warn(`   agent_id: ${agent_id || 'NOT PROVIDED'}`);
      logger.warn(`   extractedFromNumber: [redacted]`);
      logger.warn(`   extractedToNumber: [redacted]`);
      logger.warn(`   extractedCallSid: ${extractedCallSid || 'NONE'}`);
      logger.warn(`   batch_call_id: ${metadata?.batch_call?.batch_call_id || 'NONE'}`);
      logger.warn(`   webhook status: ${status || 'NONE'}`);
      logger.warn(`   metadata keys: ${metadata ? Object.keys(metadata).join(', ') : 'NONE'}`);
      logger.warn(`   All lookup paths exhausted: conversation_id match, phone+agent match, batch_call_id match, SIP match, outbound fallback, incoming fallback, failed call fallback`);
      return res.sendStatus(200);
    }

    return await processPostCallTranscription(res, ctx);
  } catch (error) {
    logger.error('❌ [ElevenLabs Webhook] Error:', error);
    // Return 200 to prevent webhook retries
    res.sendStatus(200);
  }
}
