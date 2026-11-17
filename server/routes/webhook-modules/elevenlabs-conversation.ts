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
import { calls, campaigns, agents, sipCalls } from '../../../shared/schema';
import { eq, and, or } from 'drizzle-orm';
import { twilioService } from '../../services/twilio';
import { elevenLabsService, ElevenLabsService } from '../../services/elevenlabs';
import { ElevenLabsPoolService } from '../../services/elevenlabs-pool';
import twilio from 'twilio';
import { logger } from '../../utils/logger';

/**
 * Fetch conversation details from ElevenLabs for a specific call
 * API endpoint for manual refresh or on-demand fetch
 */
export async function fetchElevenLabsConversation(req: Request, res: Response) {
  try {
    const { callId } = req.params;

    if (!callId) {
      return res.status(400).json({ error: 'Call ID is required' });
    }

    // Get call record - check main calls table first, then sip_calls table
    let callRecord: any = null;
    let isSipCall = false;

    const [mainCallRecord] = await db
      .select()
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (mainCallRecord) {
      callRecord = mainCallRecord;
    } else {
      const [sipCallRecord] = await db
        .select()
        .from(sipCalls)
        .where(eq(sipCalls.id, callId))
        .limit(1);

      if (sipCallRecord) {
        callRecord = sipCallRecord;
        isSipCall = true;
      }
    }

    if (!callRecord) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const conversationId = isSipCall ? callRecord.elevenlabsConversationId : callRecord.elevenLabsConversationId;

    if (!conversationId) {
      return res.status(400).json({ error: 'Call does not have an ElevenLabs conversation ID' });
    }

    logger.info(`📞 [Fetch Conversation] Fetching details for call: ${callId} (${isSipCall ? 'SIP' : 'standard'})`);
    logger.info(`   Conversation ID: ${conversationId}`);

    // Find the agent and credential for this call
    let agentElevenLabsService: ElevenLabsService = elevenLabsService;

    if (callRecord.agentId) {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, callRecord.agentId))
        .limit(1);

      if (agent?.elevenLabsCredentialId) {
        const credential = await ElevenLabsPoolService.getCredentialById(agent.elevenLabsCredentialId);
        if (credential) {
          agentElevenLabsService = new ElevenLabsService(credential.apiKey);
        }
      }
    } else if (callRecord.campaignId) {
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, callRecord.campaignId))
        .limit(1);

      if (campaign?.agentId) {
        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, campaign.agentId))
          .limit(1);

        if (agent?.elevenLabsCredentialId) {
          const credential = await ElevenLabsPoolService.getCredentialById(agent.elevenLabsCredentialId);
          if (credential) {
            agentElevenLabsService = new ElevenLabsService(credential.apiKey);
          }
        }
      }
    }

    // Fetch conversation details
    const conversationDetails = await agentElevenLabsService.getConversationDetails(
      conversationId
    );

    // Format transcript
    const transcriptText = conversationDetails.transcript?.map((entry: any) =>
      `${entry.role.toUpperCase()} (${entry.time_in_call_secs}s): ${entry.message}`
    ).join('\n') || '';

    const callDurationSecs = conversationDetails.call_duration_secs ||
      conversationDetails.metadata?.call_duration_secs ||
      conversationDetails.metadata?.phone_call?.call_duration_secs ||
      0;

    if (isSipCall) {
      // Update sip_calls table
      await db
        .update(sipCalls)
        .set({
          durationSeconds: callDurationSecs || callRecord.durationSeconds,
          transcript: transcriptText || callRecord.transcript,
          aiSummary: conversationDetails.analysis?.summary || callRecord.aiSummary,
          recordingUrl: conversationDetails.recording_url || callRecord.recordingUrl,
          status: conversationDetails.status === 'done' ? 'completed' : callRecord.status,
          metadata: {
            ...callRecord.metadata as object,
            elevenLabsStatus: conversationDetails.status,
            elevenLabsAnalysis: conversationDetails.analysis,
            lastFetchedAt: new Date().toISOString(),
          }
        })
        .where(eq(sipCalls.id, callId));
    } else {
      // Update main calls table (existing behavior)
      await db
        .update(calls)
        .set({
          duration: callDurationSecs || callRecord.duration,
          transcript: transcriptText || callRecord.transcript,
          aiSummary: conversationDetails.analysis?.summary || callRecord.aiSummary,
          recordingUrl: conversationDetails.recording_url || callRecord.recordingUrl,
          status: conversationDetails.status === 'done' ? 'completed' : callRecord.status,
          metadata: {
            ...callRecord.metadata as object,
            elevenLabsStatus: conversationDetails.status,
            elevenLabsAnalysis: conversationDetails.analysis,
            lastFetchedAt: new Date().toISOString(),
          }
        })
        .where(eq(calls.id, callId));
    }

    logger.info(`✅ [Fetch Conversation] Updated ${isSipCall ? 'SIP' : 'standard'} call record`);

    res.json({
      success: true,
      conversation: conversationDetails,
    });
  } catch (error: any) {
    logger.error('❌ [Fetch Conversation] Error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
}

/**
 * Get conversation audio/recording URL from ElevenLabs
 */
export async function getElevenLabsRecording(req: Request, res: Response) {
  try {
    const { callId } = req.params;

    if (!callId) {
      return res.status(400).json({ error: 'Call ID is required' });
    }

    // Get call record - check main calls table first, then sip_calls table
    let callRecord: any = null;
    let isSipCall = false;

    const [mainCallRecord] = await db
      .select()
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    if (mainCallRecord) {
      callRecord = mainCallRecord;
    } else {
      const [sipCallRecord] = await db
        .select()
        .from(sipCalls)
        .where(eq(sipCalls.id, callId))
        .limit(1);

      if (sipCallRecord) {
        callRecord = sipCallRecord;
        isSipCall = true;
      }
    }

    if (!callRecord) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // If we already have a recording URL, return it
    if (callRecord.recordingUrl) {
      return res.json({
        success: true,
        recordingUrl: callRecord.recordingUrl,
        source: 'cached',
      });
    }

    const conversationId = isSipCall ? callRecord.elevenlabsConversationId : callRecord.elevenLabsConversationId;

    if (!conversationId) {
      return res.status(400).json({ error: 'Call does not have an ElevenLabs conversation ID' });
    }

    logger.info(`🎙️ [Get Recording] Fetching audio for call: ${callId} (${isSipCall ? 'SIP' : 'standard'})`);

    // Find the agent and credential
    let agentElevenLabsService: ElevenLabsService = elevenLabsService;

    if (callRecord.agentId) {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, callRecord.agentId))
        .limit(1);

      if (agent?.elevenLabsCredentialId) {
        const credential = await ElevenLabsPoolService.getCredentialById(agent.elevenLabsCredentialId);
        if (credential) {
          agentElevenLabsService = new ElevenLabsService(credential.apiKey);
        }
      }
    } else if (callRecord.campaignId) {
      const [campaign] = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, callRecord.campaignId))
        .limit(1);

      if (campaign?.agentId) {
        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, campaign.agentId))
          .limit(1);

        if (agent?.elevenLabsCredentialId) {
          const credential = await ElevenLabsPoolService.getCredentialById(agent.elevenLabsCredentialId);
          if (credential) {
            agentElevenLabsService = new ElevenLabsService(credential.apiKey);
          }
        }
      }
    }

    // Try to get audio from ElevenLabs
    const audioResult = await agentElevenLabsService.getConversationAudio(
      conversationId
    );

    if (audioResult.audioBuffer) {
      res.json({
        success: true,
        hasRecording: true,
        contentType: audioResult.contentType,
        source: 'elevenlabs',
      });
    } else {
      // Try Twilio fallback if we have a call SID (only for non-SIP calls)
      if (!isSipCall && callRecord.twilioSid) {
        const twilioData = await twilioService.getCallDetails(callRecord.twilioSid);
        if (twilioData?.recordingUrl) {
          await db
            .update(calls)
            .set({
              recordingUrl: twilioData.recordingUrl,
            })
            .where(eq(calls.id, callId));

          res.json({
            success: true,
            hasRecording: true,
            recordingUrl: twilioData.recordingUrl,
            source: 'twilio',
          });
        } else {
          res.json({
            success: false,
            hasRecording: false,
            error: 'Recording not available from either source',
          });
        }
      } else {
        res.json({
          success: false,
          hasRecording: false,
          error: audioResult.error || 'Recording not available',
        });
      }
    }
  } catch (error: any) {
    logger.error('❌ [Get Recording] Error:', error);
    res.status(500).json({ error: 'Failed to get recording' });
  }
}
