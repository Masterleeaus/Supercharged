/** Plivo and Twilio + OpenAI Realtime test-call paths, moved out of placeFlowTestCall unchanged. */
import { db } from "../../db";
import { plivoPhoneNumbers, flowExecutions } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { PlivoCallService } from "../../engines/plivo/services/plivo-call.service";
import { OpenAIAgentFactory } from "../../engines/plivo/services/openai-agent-factory";
import { type CompiledFlowConfig } from "../../engines/plivo/types";
import { TwilioOpenAICallService } from "../../engines/twilio-openai/services/twilio-openai-call.service";
import { logger } from "../../utils/logger";
import { FlowTestHttpError, type FlowTestAgent, type FlowTestFlow, type FlowTestCompleteQueue, type FlowTestFailQueue, type FlowTestCampaignWarning } from "./flow-test-call-types";

export async function placePlivoFlowTestCall({
  userId,
  companyId,
  flow,
  agent,
  phoneNumber,
  activeCampaignWarning,
  completeQueue,
}: {
  userId: string;
  companyId: string;
  flow: FlowTestFlow;
  agent: FlowTestAgent;
  phoneNumber: string;
  activeCampaignWarning: FlowTestCampaignWarning;
  completeQueue: FlowTestCompleteQueue;
}): Promise<Record<string, unknown>> {
  // ========================================
  // PLIVO + OPENAI REALTIME PATH
  // Uses PlivoCallService with OpenAI Realtime for voice AI
  // ========================================
  logger.info(`   Using Plivo + OpenAI Realtime API`);

  try {
    // Get a Plivo phone number for this user
    const [plivoPhone] = await db
      .select()
      .from(plivoPhoneNumbers)
      .where(and(
        and(eq(plivoPhoneNumbers.userId, userId), eq(plivoPhoneNumbers.companyId, companyId)),
        eq(plivoPhoneNumbers.status, 'active')
      ))
      .limit(1);

    if (!plivoPhone) {
      throw new FlowTestHttpError(400, {
        error: "No Plivo phone number available",
        message: "Please purchase a Plivo phone number first in the Phone Numbers section.",
      });
    }

    // Use pre-compiled flow data if available, otherwise compile at runtime
    const validatedVoice = OpenAIAgentFactory.validateVoice(agent.openaiVoice || 'sage');
    const validatedModel = OpenAIAgentFactory.validateModel(
      (agent.config as any)?.openaiModel || (agent as any).llmModel || 'gpt-realtime-1.5',
      'pro'
    );

    let compiledConfig: any;

    // Generate a temporary call ID for tool context (will be replaced by actual call ID after initiation)
    const tempCallId = nanoid();

    if (flow.compiledSystemPrompt && flow.compiledTools && flow.compiledStates) {
      // Use pre-compiled flow data (compiled at save time)
      logger.info(`   Using pre-compiled flow data (${(flow.compiledTools as any[]).length} tools, ${(flow.compiledStates as any[]).length} states)`);

      const { hydrateCompiledFlow } = await import('../services/openai-voice-agent/hydrator');
      compiledConfig = hydrateCompiledFlow({
        compiledSystemPrompt: flow.compiledSystemPrompt,
        compiledFirstMessage: flow.compiledFirstMessage || null,
        compiledTools: flow.compiledTools as any[],
        compiledStates: flow.compiledStates as any[],
        voice: validatedVoice,
        model: validatedModel,
        temperature: agent.temperature ?? 0.7,
        toolContext: {
          userId,
          agentId: agent.id,
          callId: tempCallId,
        },
        language: agent.language || 'en',
        knowledgeBaseIds: agent.knowledgeBaseIds || [],
        transferPhoneNumber: agent.transferPhoneNumber || undefined,
        transferEnabled: agent.transferEnabled || false,
      });
    } else {
      // Fall back to runtime compilation (legacy flows)
      logger.info(`   Compiling flow at runtime (no pre-compiled data)`);

      const flowConfig: CompiledFlowConfig = {
        nodes: flow.nodes as any[],
        edges: flow.edges as any[],
        variables: {},
      };

      compiledConfig = await OpenAIAgentFactory.compileFlow(flowConfig, {
        voice: validatedVoice,
        model: validatedModel,
        userId,
        agentId: agent.id,
        temperature: agent.temperature ?? 0.7,
      });
    }

    const { callUuid, plivoCall } = await PlivoCallService.initiateCall({
      fromNumber: plivoPhone.phoneNumber,
      toNumber: phoneNumber,
      userId,
      agentId: agent.id,
      plivoPhoneNumberId: plivoPhone.id,
      flowId: flow.id, // Pass the tested flowId (not agent's default flow)
      agentConfig: {
        voice: compiledConfig.voice,
        model: compiledConfig.model,
        systemPrompt: compiledConfig.systemPrompt,
        firstMessage: compiledConfig.firstMessage,
        tools: compiledConfig.tools,
      },
    });

    logger.info(`✅ [Flow Test] Plivo outbound call initiated`);
    logger.info(`   Call ID: ${plivoCall.id}`);
    logger.info(`   Plivo UUID: ${callUuid}`);
    logger.info(`   Flow: ${flow.name} (${flow.id})`);
    logger.info(`   From: [redacted] -> To: [redacted]`);

    // Create flow execution record for test call
    try {
      await db.insert(flowExecutions).values({
        id: nanoid(),
        companyId,
        callId: plivoCall.id,
        flowId: flow.id,
        currentNodeId: null,
        status: 'running',
        variables: {},
        pathTaken: [],
        startedAt: new Date(),
        metadata: {
          campaignId: null,
          campaignName: null,
          contactPhone: phoneNumber,
          nativeExecution: true,
          telephonyProvider: 'plivo',
          testCall: true,
        },
      });
      logger.info(`🔀 [Flow Test] Created flow execution for Plivo test call`);
    } catch (flowExecError: any) {
      logger.warn(`⚠️ [Flow Test] Error creating flow execution:`, flowExecError.message);
    }

    await completeQueue(plivoCall.id);
    return {
      success: true,
      callId: plivoCall.id,
      conversationId: plivoCall.id,
      plivoUuid: callUuid,
      flowId: flow.id,
      flowName: flow.name,
      fromNumber: plivoPhone.phoneNumber,
      toNumber: phoneNumber,
      message: "Test call initiated successfully via Plivo + OpenAI Realtime. The agent will execute the workflow.",
      engine: 'plivo_openai',
      ...(activeCampaignWarning && { warning: activeCampaignWarning }),
    };

  } catch (plivoError: any) {
    logger.error(`❌ [Flow Test] Plivo call error:`, plivoError);
    throw new FlowTestHttpError(400, {
      error: "Call initiation failed",
      message: "Failed to initiate call via Plivo",
    });
  }
}

export async function placeTwilioOpenAIFlowTestCall({
  userId,
  companyId,
  flow,
  agent,
  phoneNumber,
  fromPhone,
  activeCampaignWarning,
  completeQueue,
  failQueue,
}: {
  userId: string;
  companyId: string;
  flow: FlowTestFlow;
  agent: FlowTestAgent;
  phoneNumber: string;
  fromPhone: any;
  activeCampaignWarning: FlowTestCampaignWarning;
  completeQueue: FlowTestCompleteQueue;
  failQueue: FlowTestFailQueue;
}): Promise<Record<string, unknown>> {
  // ========================================
  // TWILIO + OPENAI REALTIME PATH
  // Creates record directly in twilioOpenaiCalls table (not calls table)
  // ========================================
  logger.info(`   Using Twilio + OpenAI Realtime API`);

  try {
    const callResult = await TwilioOpenAICallService.initiateCall({
      userId,
      agentId: agent.id,
      toNumber: phoneNumber,
      fromNumberId: fromPhone.id,
      campaignId: undefined,
      contactId: undefined,
      flowId: flow.id,
      metadata: {
        source: 'flow_test',
        flowId: flow.id,
        flowName: flow.name,
        testCall: true,
      }
    });

    if (!callResult.success) {
      logger.error(`❌ [Flow Test] Twilio+OpenAI call initiation failed:`, callResult.error);
      throw new FlowTestHttpError(400, {
        error: "Call initiation failed",
        message: callResult.error || "Failed to initiate call via Twilio+OpenAI Realtime",
      });
    }

    logger.info(`✅ [Flow Test] Twilio+OpenAI outbound call initiated`);
    logger.info(`   Call ID: ${callResult.callId}`);
    logger.info(`   Twilio SID: ${callResult.twilioCallSid}`);
    logger.info(`   Flow: ${flow.name} (${flow.id})`);
    logger.info(`   From: [redacted] -> To: [redacted]`);

    // Create flow execution record for test call
    if (callResult.callId) {
      try {
        await db.insert(flowExecutions).values({
          id: nanoid(),
          companyId,
          callId: callResult.callId,
          flowId: flow.id,
          currentNodeId: null,
          status: 'running',
          variables: {},
          pathTaken: [],
          startedAt: new Date(),
          metadata: {
            campaignId: null,
            campaignName: null,
            contactPhone: phoneNumber,
            nativeExecution: true,
            telephonyProvider: 'twilio-openai',
            testCall: true,
            twilioSid: callResult.twilioCallSid,
          },
        });
        logger.info(`🔀 [Flow Test] Created flow execution for Twilio+OpenAI test call`);
      } catch (flowExecError: any) {
        logger.warn(`⚠️ [Flow Test] Error creating flow execution:`, flowExecError.message);
      }
    }

    // OpenAI calls use twilioOpenaiCalls table, return the callId from that table
    await completeQueue(callResult.callId!);
    return {
      success: true,
      callId: callResult.callId,
      conversationId: callResult.callId,
      twilioSid: callResult.twilioCallSid,
      flowId: flow.id,
      flowName: flow.name,
      fromNumber: fromPhone.phoneNumber,
      toNumber: phoneNumber,
      message: "Test call initiated successfully via Twilio+OpenAI Realtime. The agent will execute the workflow.",
      engine: 'twilio_openai',
      ...(activeCampaignWarning && { warning: activeCampaignWarning }),
    };

  } catch (openaiError: any) {
    if (openaiError instanceof FlowTestHttpError) throw openaiError;
    logger.error(`❌ [Flow Test] Twilio+OpenAI call error:`, openaiError);
    await failQueue("Failed to initiate call via Twilio+OpenAI");
    throw new FlowTestHttpError(400, {
      error: "Call initiation failed",
      message: "Failed to initiate call via Twilio+OpenAI",
    });
  }
}
