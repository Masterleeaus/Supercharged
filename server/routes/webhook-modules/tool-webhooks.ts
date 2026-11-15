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
import { calls, campaigns, incomingAgents, incomingConnections, agents, sipCalls } from '../../../shared/schema';
import { eq, and, or, inArray, sql } from 'drizzle-orm';
import { getTwilioClient } from '../../services/twilio-connector';
import { getDomain } from '../../utils/domain';
import twilio from 'twilio';
import { logger } from '../../utils/logger';
import { flowExecutions } from '@shared/schema';

/**
 * RAG Knowledge Base Tool Webhook Handler
 * 
 * This endpoint is called by ElevenLabs when an agent uses the ask_knowledge tool.
 * It searches the RAG knowledge base and returns relevant information.
 * 
 * Security: Validates token via URL path (primary) or X-RAG-Token header (fallback)
 * 
 * Endpoint: POST /api/webhooks/elevenlabs/rag-tool/:token/:elevenLabsAgentId
 */
export async function handleRAGToolWebhook(req: Request, res: Response) {
  // Support both URL patterns:
  // - New: /api/webhooks/elevenlabs/rag-tool/:token/:agentId
  // - Legacy: /api/webhooks/elevenlabs/rag-tool/:agentId (with header auth)
  const { token: urlToken, agentId: elevenLabsAgentId } = req.params;

  logger.info(`📚 [RAG Webhook] Received tool call for ElevenLabs agent: ${elevenLabsAgentId}`);

  // Debug: Log all headers to see what ElevenLabs sends
  logger.info(`📚 [RAG Webhook] Request headers:`);

  try {
    // Validate authentication token - try URL token first, then header
    const { validateRAGWebhookToken } = await import('../../services/rag-elevenlabs-tool');
    const headerToken = req.headers['x-rag-token'] as string | undefined;
    const providedToken = urlToken || headerToken;

    logger.info(`📚 [RAG Webhook] Token sources - URL: ${urlToken ? 'present' : 'missing'}, Header: ${headerToken ? 'present' : 'missing'}`);

    if (!validateRAGWebhookToken(providedToken)) {
      logger.warn(`📚 [RAG Webhook] Invalid or missing authentication token`);
      logger.warn(`   Request path: [redacted]`);
      logger.warn(`   Header token: [redacted]`);
      return res.status(401).json({
        response: "Unauthorized: Invalid authentication token",
        sources: []
      });
    }

    logger.info(`📚 [RAG Webhook] Authentication successful via ${urlToken ? 'URL' : 'header'} token`);

    logger.info(`   Request body:`);

    // Extract the query from the request body
    // ElevenLabs sends the tool parameters in the body
    const query = req.body?.query || req.body?.parameters?.query || '';

    if (!query || typeof query !== 'string') {
      logger.warn(`📚 [RAG Webhook] Invalid query received`);
      return res.json({
        response: "I need a search query to look up information in the knowledge base.",
        sources: []
      });
    }

    logger.info(`📚 [RAG Webhook] Query: "${query.substring(0, 100)}..."`);

    // Look up the agent by ElevenLabs agent ID to get user ID and knowledge base IDs
    // First try incoming agents table
    let agent = await db
      .select()
      .from(incomingAgents)
      .where(eq(incomingAgents.elevenLabsAgentId, elevenLabsAgentId))
      .limit(1);

    let userId: string | null = null;
    let companyId: string | null = null;
    let knowledgeBaseIds: string[] = [];

    // Company and owner both come from the same agent row. Nothing is read from the request body for scope.
    if (agent.length > 0) {
      userId = agent[0].userId;
      companyId = agent[0].companyId ?? null;
      knowledgeBaseIds = agent[0].knowledgeBaseIds || [];
      logger.info(`📚 [RAG Webhook] Found incoming agent, user: ${userId}, KBs: ${knowledgeBaseIds.length}`);
    } else {
      // Try the regular agents table
      const regularAgent = await db
        .select()
        .from(agents)
        .where(eq(agents.elevenLabsAgentId, elevenLabsAgentId))
        .limit(1);

      if (regularAgent.length > 0) {
        userId = regularAgent[0].userId;
        companyId = regularAgent[0].companyId ?? null;
        knowledgeBaseIds = regularAgent[0].knowledgeBaseIds || [];
        logger.info(`📚 [RAG Webhook] Found regular agent, user: ${userId}, KBs: ${knowledgeBaseIds.length}`);
      }
    }

    if (!userId) {
      logger.warn(`📚 [RAG Webhook] ElevenLabs agent ${elevenLabsAgentId} not found`);
      return res.json({
        response: "I couldn't find the knowledge base for this agent.",
        sources: []
      });
    }

    if (!companyId) {
      // Fail closed: an agent row with no company cannot be scoped, so no search runs.
      logger.warn(`📚 [RAG Webhook] ElevenLabs agent ${elevenLabsAgentId} has no company scope, refusing`);
      return res.json({
        response: "I couldn't find the knowledge base for this agent.",
        sources: []
      });
    }

    if (knowledgeBaseIds.length === 0) {
      logger.warn(`📚 [RAG Webhook] No knowledge bases assigned to agent ${elevenLabsAgentId}`);
      return res.json({
        response: "This agent doesn't have a knowledge base configured yet.",
        sources: []
      });
    }

    // Import the RAG tool handler
    const { handleAskKnowledgeToolCall } = await import('../../services/rag-elevenlabs-tool');

    // Process the query through RAG
    const result = await handleAskKnowledgeToolCall(query, knowledgeBaseIds, { companyId, userId });

    logger.info(`📚 [RAG Webhook] Returning result with ${result.sources.length} sources`);
    logger.info(`   Response preview: "${result.response.substring(0, 100)}..."`);

    // Return the result in a format ElevenLabs expects
    // For webhook tools, ElevenLabs expects a JSON response that becomes the tool result
    return res.json({
      response: result.response,
      sources: result.sources
    });

  } catch (error: any) {
    logger.error(`❌ [RAG Webhook] Error:`, error.message);
    return res.json({
      response: "I encountered an error while searching the knowledge base. Please try again.",
      sources: []
    });
  }
}

/**
 * Handle Play Audio tool webhook - called by ElevenLabs when play_audio node executes
 * Uses Twilio REST API to play audio on the active call
 * 
 * URL format: /api/elevenlabs/tools/play-audio/:agentId
 * The agentId is the ElevenLabs agent ID, used to look up the active call
 * The audioUrl comes from the webhook payload configured in the flow
 */
export async function handlePlayAudioToolWebhook(req: Request, res: Response): Promise<void> {
  const { agentId: elevenLabsAgentId } = req.params;

  try {
    logger.info('[PlayAudio Webhook] Received request for agent:', elevenLabsAgentId);
    logger.info('[PlayAudio Webhook] Request body:');

    const { audioUrl, interruptible, waitForComplete } = req.body;

    if (!audioUrl) {
      logger.error('[PlayAudio Webhook] Missing audioUrl');
      res.status(400).json({ error: 'Missing audioUrl' });
      return;
    }

    // Look up the agent by ElevenLabs agent ID to find the active call
    const agent = await db
      .select({ id: agents.id, userId: agents.userId })
      .from(agents)
      .where(eq(agents.elevenLabsAgentId, elevenLabsAgentId))
      .limit(1);

    if (agent.length === 0) {
      logger.warn(`[PlayAudio Webhook] No agent found with ElevenLabs ID ${elevenLabsAgentId}`);
      res.json({
        success: false,
        message: "Could not find the agent to play audio."
      });
      return;
    }

    const dbAgentId = agent[0].id;
    const userId = agent[0].userId;

    // ========================================
    // CHECK FOR ELEVENLABS SIP CALLS FIRST
    // ElevenLabs SIP calls are managed by ElevenLabs natively - audio is handled
    // through the ElevenLabs workflow, not via Twilio
    // Only match calls with engine 'elevenlabs-sip' to avoid false positives
    // ========================================
    const [activeSipCall] = await db
      .select({
        id: sipCalls.id,
        engine: sipCalls.engine,
        status: sipCalls.status,
        externalCallId: sipCalls.externalCallId
      })
      .from(sipCalls)
      .where(
        and(
          eq(sipCalls.agentId, dbAgentId),
          eq(sipCalls.engine, 'elevenlabs-sip'),
          inArray(sipCalls.status, ['initiated', 'ringing', 'in-progress', 'connected'])
        )
      )
      .orderBy(sql`${sipCalls.startedAt} DESC`)
      .limit(1);

    if (activeSipCall) {
      // SIP call found - ElevenLabs handles audio natively through the workflow
      // For ElevenLabs SIP, the audio URL is already configured in the workflow tool
      // The webhook acknowledgment allows the flow to continue
      const domain = getDomain();
      // Handle various audio URL formats
      let resolvedUrl = audioUrl;
      if (!audioUrl.startsWith('http')) {
        if (!audioUrl.startsWith('/')) {
          resolvedUrl = `/audio/${audioUrl}`;
        }
      }
      const fullAudioUrl = audioUrl.startsWith('http') ? audioUrl : `${domain}${resolvedUrl}`;

      logger.info(`[PlayAudio Webhook] SIP call detected (${activeSipCall.engine})`);
      logger.info(`   Call ID: ${activeSipCall.id}`);
      logger.info(`   Audio URL: [redacted]`);
      logger.info(`   Note: ElevenLabs SIP handles audio natively through the workflow`);

      // Return success so ElevenLabs workflow continues
      // The audio playback is handled by ElevenLabs through its native workflow execution
      res.json({
        success: true,
        message: 'Audio acknowledged for SIP call - ElevenLabs handles playback natively',
        audioUrl: fullAudioUrl,
        engine: activeSipCall.engine,
        callId: activeSipCall.id
      });
      return;
    }

    // ========================================
    // REGULAR TWILIO-BASED CALLS
    // ========================================

    // Find the most recent in-progress call for this specific agent
    // Strategy: Query calls through campaigns that use this agent
    // This ensures we target the correct call even with concurrent calls
    const [activeCall] = await db
      .select({
        id: calls.id,
        twilioSid: calls.twilioSid,
        status: calls.status,
        campaignId: calls.campaignId
      })
      .from(calls)
      .innerJoin(campaigns, eq(calls.campaignId, campaigns.id))
      .where(
        and(
          eq(campaigns.agentId, dbAgentId),
          eq(calls.status, 'in-progress')
        )
      )
      .orderBy(sql`${calls.createdAt} DESC`)
      .limit(1);

    // If no campaign-based call found, try incoming connections for this agent
    let callSid: string | null = activeCall?.twilioSid || null;

    if (!callSid) {
      // Check incoming connections for this agent
      const [incomingCall] = await db
        .select({
          id: calls.id,
          twilioSid: calls.twilioSid,
          status: calls.status
        })
        .from(calls)
        .innerJoin(incomingConnections, eq(calls.incomingConnectionId, incomingConnections.id))
        .where(
          and(
            eq(incomingConnections.agentId, dbAgentId),
            eq(calls.status, 'in-progress')
          )
        )
        .orderBy(sql`${calls.createdAt} DESC`)
        .limit(1);

      callSid = incomingCall?.twilioSid || null;
    }

    // If still no call found, check for flow test calls via flowExecutions
    // Flow test calls link: agent.flowId -> flowExecutions.flowId -> flowExecutions.callId -> calls.twilioSid
    if (!callSid) {
      // Get the agent's flowId to find associated flow executions
      const [agentFlow] = await db
        .select({ flowId: agents.flowId })
        .from(agents)
        .where(eq(agents.id, dbAgentId));

      if (agentFlow?.flowId) {
        // Find in-progress flow executions for this flow
        const [flowTestCall] = await db
          .select({
            id: calls.id,
            twilioSid: calls.twilioSid,
            status: calls.status
          })
          .from(calls)
          .innerJoin(flowExecutions, eq(flowExecutions.callId, calls.id))
          .where(
            and(
              eq(flowExecutions.flowId, agentFlow.flowId),
              eq(calls.status, 'in-progress'),
              eq(calls.userId, userId)
            )
          )
          .orderBy(sql`${calls.createdAt} DESC`)
          .limit(1);

        if (flowTestCall?.twilioSid) {
          callSid = flowTestCall.twilioSid;
          logger.info(`[PlayAudio Webhook] Found flow test call: ${callSid}`);
        }
      }
    }

    if (!callSid) {
      logger.warn(`[PlayAudio Webhook] No active call with Twilio SID found for agent ${dbAgentId}`);
      // Don't fail - the audio might have been requested but call ended
      res.json({
        success: false,
        message: "No active call found. Audio playback skipped."
      });
      return;
    }

    // Get the base URL for audio files
    const domain = getDomain();
    // Handle various audio URL formats:
    // - Full URL: https://domain.com/audio/file.mp3
    // - Path: /audio/file.mp3
    // - Filename only: file.mp3 (assume it's in /audio/)
    let resolvedAudioUrl = audioUrl;
    if (!audioUrl.startsWith('http')) {
      if (!audioUrl.startsWith('/')) {
        resolvedAudioUrl = `/audio/${audioUrl}`;
      }
    }
    const fullAudioUrl = audioUrl.startsWith('http') ? audioUrl : `${domain}${resolvedAudioUrl}`;

    logger.info(`[PlayAudio Webhook] Playing audio on call ${callSid}: [redacted]`);

    // Use Twilio REST API to play audio on the call
    const twilioClient = await getTwilioClient();
    if (!twilioClient) {
      logger.error('[PlayAudio Webhook] Twilio client not available');
      res.status(500).json({ error: 'Twilio client not configured' });
      return;
    }

    try {
      // Create TwiML to play the audio
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.play({ loop: 1 }, fullAudioUrl);

      // Update the call with the new TwiML
      await twilioClient.calls(callSid).update({
        twiml: twiml.toString()
      });

      logger.info(`[PlayAudio Webhook] Audio playback initiated on call ${callSid}`);
      res.json({
        success: true,
        message: 'Audio playback initiated',
        audioUrl: fullAudioUrl,
        callSid
      });
    } catch (twilioError: any) {
      logger.error('[PlayAudio Webhook] Twilio API error:', twilioError.message);
      res.status(500).json({
        error: 'Failed to play audio',
        details: 'An error occurred while initiating audio playback'
      });
    }
  } catch (error: any) {
    logger.error('[PlayAudio Webhook] Error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
}
