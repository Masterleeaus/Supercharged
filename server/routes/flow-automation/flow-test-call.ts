/** Flow test-call helper (placeFlowTestCall) and POST /flows/:id/test route. */
import { Router, Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { flows, flowExecutions, flowTestQueue, calls, agents, contacts, sipPhoneNumbers, sipCalls } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { checkDemoCallLimit, logDemoCall } from "../../demo-mode";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { getPluginStatus } from "../../plugins/loader";
import { consumePendingFailure } from "../webhook-routes";
import { logger } from "../../utils/logger";
import { companyForRead } from "./shared";
import { FlowTestHttpError } from "./flow-test-call-types";
import { selectFlowTestFromPhone, findFlowTestCampaignWarning } from "./flow-test-call-phone";
import { placeCustomVoiceEngineFlowTestCall } from "./flow-test-call-custom-voice";
import { placePlivoFlowTestCall, placeTwilioOpenAIFlowTestCall } from "./flow-test-call-providers";
import { prepareElevenLabsTestPhone, placeElevenLabsTestCall } from "./flow-test-call-elevenlabs";

export { FlowTestHttpError };

export async function placeFlowTestCall({
  userId,
  companyId,
  flowId,
  toPhone,
  queueEntryId,
  clientIp,
}: {
  userId: string;
  companyId: string;
  flowId: string;
  toPhone: string;
  queueEntryId?: string;
  clientIp?: string;
}): Promise<Record<string, unknown>> {
  const phoneNumber = toPhone;
  const id = flowId;

  let queueProcessed = false;
  const completeQueue = async (resolvedCallId: string) => {
    if (!queueEntryId || queueProcessed) return;
    queueProcessed = true;
    try {
      await db.update(flowTestQueue)
        .set({ status: 'completed', callId: resolvedCallId, processedAt: new Date() })
        .where(and(
          eq(flowTestQueue.id, queueEntryId),
          eq(flowTestQueue.userId, userId),
          eq(flowTestQueue.status, 'processing')
        ));
    } catch (e) { console.error('[Queue] Failed to mark completed:', e); }
  };
  const failQueue = async (reason: string) => {
    if (!queueEntryId || queueProcessed) return;
    queueProcessed = true;
    try {
      await db.update(flowTestQueue)
        .set({ status: 'failed', errorMessage: reason, processedAt: new Date() })
        .where(and(
          eq(flowTestQueue.id, queueEntryId),
          eq(flowTestQueue.userId, userId),
          eq(flowTestQueue.status, 'processing')
        ));
    } catch (e) { console.error('[Queue] Failed to mark failed:', e); }
  };

  try {

    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.userId, userId), eq(flows.companyId, companyId)));

    if (!flow) {
      throw new FlowTestHttpError(404, { error: "Flow not found" });
    }

    if (!flow.isActive) {
      throw new FlowTestHttpError(400, { error: "Flow must be active to test" });
    }

    if (!flow.agentId) {
      throw new FlowTestHttpError(400, {
        error: "Flow must have an agent assigned before testing",
        message: "Please assign an agent to this flow in the flow builder settings.",
      });
    }

    let agent = (await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, flow.agentId), eq(agents.companyId, companyId))))[0];

    if (!agent) {
      const veAgentResult = await db.execute(sql`
        SELECT * FROM ve_voice_agents WHERE id = ${flow.agentId} LIMIT 1
      `);
      if (veAgentResult.rows.length > 0) {
        const veAgent = veAgentResult.rows[0] as any;
        agent = {
          id: veAgent.id,
          userId: veAgent.user_id,
          name: veAgent.name,
          type: 'flow',
          telephonyProvider: 'custom-voice-engine',
          systemPrompt: veAgent.system_prompt,
          firstMessage: veAgent.first_message,
          language: veAgent.language,
          llmModel: veAgent.llm_model,
          temperature: veAgent.temperature,
          openaiVoice: veAgent.tts_voice,
          maxDurationSeconds: veAgent.max_duration_seconds,
          isActive: veAgent.is_active,
          openaiModel: 'gpt-realtime-1.5',
          knowledgeBaseIds: veAgent.knowledge_base_ids || [],
          transferPhoneNumber: null,
          transferEnabled: false,
          endConversationEnabled: true,
        } as any;
      }
    }

    if (!agent) {
      throw new FlowTestHttpError(400, {
        error: "Agent not found",
        message: "The agent assigned to this flow no longer exists.",
      });
    }

    // ========================================
    // ELEVENLABS SIP PATH - Uses SIP phone numbers from plugin
    // Must be checked BEFORE regular phone number selection
    // ========================================
    if (agent.telephonyProvider === 'elevenlabs-sip') {
      logger.info(`📞 [Flow Test] ElevenLabs SIP agent detected, using SIP phone numbers`);

      const plugins = await getPluginStatus();
      const sipPlugin = plugins.find(p => p.name === 'sip-engine');
      if (!sipPlugin?.enabled) {
        throw new FlowTestHttpError(400, {
          error: "SIP Engine plugin not enabled",
          message: "The SIP Engine plugin must be enabled to use ElevenLabs SIP agents. Please contact your administrator.",
        });
      }

      // Auto-select user's first available SIP phone number with ElevenLabs engine
      const [sipPhone] = await db
        .select()
        .from(sipPhoneNumbers)
        .where(and(
          eq(sipPhoneNumbers.userId, userId),
          eq(sipPhoneNumbers.companyId, companyId),
          eq(sipPhoneNumbers.engine, 'elevenlabs-sip'),
          eq(sipPhoneNumbers.isActive, true),
          eq(sipPhoneNumbers.outboundEnabled, true)
        ))
        .limit(1);

      if (!sipPhone) {
        throw new FlowTestHttpError(400, {
          error: "No SIP phone number available",
          message: "Please import a phone number from your SIP trunk in the Phone Numbers section before making test calls.",
        });
      }

      if (!sipPhone.externalElevenLabsPhoneId) {
        throw new FlowTestHttpError(400, {
          error: "SIP phone number not provisioned",
          message: "This SIP phone number has not been provisioned with ElevenLabs. Please check your SIP trunk configuration.",
        });
      }

      if (!agent.elevenLabsAgentId) {
        throw new FlowTestHttpError(400, {
          error: "Agent not synced with ElevenLabs",
          message: "Please configure and sync the agent with ElevenLabs in the Agents section first.",
        });
      }

      // Get the ElevenLabs credential for this agent
      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        throw new FlowTestHttpError(400, {
          error: "No ElevenLabs credential found for agent",
          message: "Please configure ElevenLabs credentials for the agent first.",
        });
      }

      let currentSipPhoneElevenLabsId = sipPhone.externalElevenLabsPhoneId;
      const { verifySipPhoneExists, resyncSipPhoneCredentials } = await import('../services/elevenlabs-phone-resync');

      // SIP PRE-FLIGHT CHECK 1: Credential mismatch
      if (sipPhone.elevenLabsCredentialId && agent.elevenLabsCredentialId &&
        sipPhone.elevenLabsCredentialId !== agent.elevenLabsCredentialId) {
        logger.info(`📞 [Flow Test] SIP phone credential mismatch — resyncing to agent credential`);
        logger.info(`   SIP phone credential: ${sipPhone.elevenLabsCredentialId}`);
        logger.info(`   Agent credential: ${agent.elevenLabsCredentialId}`);

        try {
          const migResult = await resyncSipPhoneCredentials(sipPhone.id, agent.elevenLabsCredentialId);
          if (!migResult.success) {
            throw new FlowTestHttpError(400, {
              error: "SIP call initiation failed",
              message: `SIP phone credential migration failed: ${migResult.error}`,
            });
          }
          if (migResult.newElevenLabsPhoneId) {
            currentSipPhoneElevenLabsId = migResult.newElevenLabsPhoneId;
            sipPhone.externalElevenLabsPhoneId = migResult.newElevenLabsPhoneId;
          }
          logger.info(`✅ [Flow Test] SIP phone migrated to agent credential, new ID: ${currentSipPhoneElevenLabsId}`);
        } catch (migError: any) {
          if (migError instanceof FlowTestHttpError) throw migError;
          throw new FlowTestHttpError(400, {
            error: "SIP call initiation failed",
            message: `SIP phone credential migration error: ${migError.message}`,
          });
        }
      }

      // SIP PRE-FLIGHT CHECK 2: Verify SIP phone still exists on ElevenLabs
      logger.info(`📞 [Flow Test] Verifying SIP phone exists on ElevenLabs...`);
      try {
        const sipVerify = await verifySipPhoneExists(currentSipPhoneElevenLabsId, credential.apiKey);
        if (!sipVerify.exists) {
          if (sipVerify.notFound) {
            logger.warn(`⚠️ [Flow Test] SIP phone ${currentSipPhoneElevenLabsId} not found on ElevenLabs — re-importing`);
            const reimportResult = await resyncSipPhoneCredentials(sipPhone.id, credential.id);
            if (!reimportResult.success) {
              throw new FlowTestHttpError(400, {
                error: "SIP call initiation failed",
                message: `SIP phone re-import failed: ${reimportResult.error}`,
              });
            }
            if (reimportResult.newElevenLabsPhoneId) {
              currentSipPhoneElevenLabsId = reimportResult.newElevenLabsPhoneId;
              sipPhone.externalElevenLabsPhoneId = reimportResult.newElevenLabsPhoneId;
            }
            logger.info(`✅ [Flow Test] SIP phone re-imported, new ID: ${currentSipPhoneElevenLabsId}`);
          } else {
            console.warn(`⚠️ [Flow Test] Cannot verify SIP phone on ElevenLabs (transient error): ${sipVerify.error}`);
          }
        } else {
          logger.info(`✅ [Flow Test] SIP phone exists on ElevenLabs`);
        }
      } catch (verifyError: any) {
        if (verifyError instanceof FlowTestHttpError) throw verifyError;
        console.warn(`⚠️ [Flow Test] Cannot verify SIP phone on ElevenLabs (error): ${verifyError.message}`);
      }

      try {
        // Use the plugin's ElevenLabsSipService.makeOutboundCall
        const { importPlugin } = await import('../utils/plugin-import');
        const { ElevenLabsSipService } = await importPlugin('plugins/sip-engine/services/elevenlabs-sip.service.ts');

        logger.info(`📞 [Flow Test] Initiating SIP test call via ElevenLabs SIP Trunk API`);
        logger.info(`   From SIP Phone: [redacted] (ElevenLabs ID: ${sipPhone.externalElevenLabsPhoneId})`);
        logger.info(`   To: [redacted]`);
        logger.info(`   Agent (ElevenLabs ID): ${agent.elevenLabsAgentId}`);

        // Extract dynamic variable placeholders from flow's first message
        // For test calls without a contact, pass placeholder values so ElevenLabs doesn't reject
        let sipFlowFirstMessage = '';
        if (flow.compiledFirstMessage) {
          sipFlowFirstMessage = flow.compiledFirstMessage as string;
        } else {
          const sipFirstMsgNode = (flow.nodes as any[]).find((n: any) => n.type === 'message');
          if (sipFirstMsgNode?.data?.config?.message) {
            sipFlowFirstMessage = sipFirstMsgNode.data.config.message;
          } else if (sipFirstMsgNode?.data?.message) {
            sipFlowFirstMessage = sipFirstMsgNode.data.message;
          } else {
            sipFlowFirstMessage = agent.firstMessage || '';
          }
        }
        logger.info(`   [SIP Test] First message for variable extraction: "${sipFlowFirstMessage?.substring(0, 80)}..."`);

        // Look up contact by phoneNumber (matching last 10 digits) to get real name if exists
        const sipDigits = phoneNumber.replace(/\D/g, '');
        let sipContactRecord: any = null;
        if (sipDigits.length >= 10) {
          const last10 = sipDigits.slice(-10);
          const [foundContact] = await db
            .select()
            .from(contacts)
            .where(and(sql`${contacts.phone} LIKE ${'%' + last10}`, eq(contacts.companyId, companyId)))
            .limit(1);
          if (foundContact) {
            sipContactRecord = foundContact;
            logger.info(`   📞 [Flow Test] Found contact in database for SIP test: ${sipContactRecord.firstName} ${sipContactRecord.lastName || ''}`);
          }
        }

        const sipVarPattern = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
        const sipDynamicVars: Record<string, string> = {};

        if (sipContactRecord) {
          const fullName = (sipContactRecord.firstName + ' ' + (sipContactRecord.lastName || '')).trim();
          sipDynamicVars['contact_name'] = fullName;
          sipDynamicVars['name'] = fullName;
          sipDynamicVars['contact_first_name'] = sipContactRecord.firstName || '';
          sipDynamicVars['first_name'] = sipContactRecord.firstName || '';
          sipDynamicVars['firstName'] = sipContactRecord.firstName || '';
          sipDynamicVars['contact_last_name'] = sipContactRecord.lastName || '';
          sipDynamicVars['last_name'] = sipContactRecord.lastName || '';
          sipDynamicVars['lastName'] = sipContactRecord.lastName || '';
          sipDynamicVars['contact_phone'] = phoneNumber;
          sipDynamicVars['phone'] = phoneNumber;
          if (sipContactRecord.email) {
            sipDynamicVars['contact_email'] = sipContactRecord.email;
            sipDynamicVars['email'] = sipContactRecord.email;
          }
          if (sipContactRecord.customFields && typeof sipContactRecord.customFields === 'object') {
            for (const [key, val] of Object.entries(sipContactRecord.customFields)) {
              if (val !== null && val !== undefined) {
                sipDynamicVars[key] = String(val);
              }
            }
          }
        } else {
          sipDynamicVars['contact_name'] = 'Test User';
          sipDynamicVars['name'] = 'Test User';
          sipDynamicVars['contact_first_name'] = 'Test';
          sipDynamicVars['first_name'] = 'Test';
          sipDynamicVars['firstName'] = 'Test';
          sipDynamicVars['contact_last_name'] = 'User';
          sipDynamicVars['last_name'] = 'User';
          sipDynamicVars['lastName'] = 'User';
          sipDynamicVars['contact_phone'] = phoneNumber;
          sipDynamicVars['phone'] = phoneNumber;
          sipDynamicVars['contact_email'] = 'test@example.com';
          sipDynamicVars['email'] = 'test@example.com';
        }

        let sipMatch;
        while ((sipMatch = sipVarPattern.exec(sipFlowFirstMessage)) !== null) {
          const varName = sipMatch[1];
          if (!sipDynamicVars[varName]) {
            sipDynamicVars[varName] = `[${varName}]`;
          }
        }

        if (Object.keys(sipDynamicVars).length > 0) {
          logger.info(`   Detected dynamic variables in first message, passing placeholders:`, JSON.stringify(sipDynamicVars));
        }

        // Always ensure contact_phone is in dynamic vars — prevents the agent asking
        // the caller for their own number during form collection.
        if (!sipDynamicVars.contact_phone && !sipDynamicVars.phone) {
          sipDynamicVars.contact_phone = phoneNumber;
        }

        const sipClientData: Record<string, unknown> = {
          source: 'flow_test',
          flowId: flow.id,
          flowName: flow.name,
          testCall: true,
        };
        sipClientData.dynamic_variables = sipDynamicVars;

        const result = await ElevenLabsSipService.makeOutboundCall(
          userId,
          sipPhone as any,
          phoneNumber,
          agent.id,
          sipClientData
        );

        if (!result.success) {
          throw new FlowTestHttpError(400, {
            error: "SIP call initiation failed",
            message: result.error || "Failed to initiate call via ElevenLabs SIP Trunk",
          });
        }

        logger.info(`✅ [Flow Test] ElevenLabs SIP outbound call initiated`);
        logger.info(`   Conversation ID: ${result.conversationId}`);
        logger.info(`   Call ID: ${result.callId}`);

        // Create SIP call record
        const [insertedSipCall] = await db.insert(sipCalls).values({
          sipPhoneNumberId: sipPhone.id,
          userId: userId,
          agentId: agent.id,
          direction: 'outbound',
          engine: 'elevenlabs-sip',
          toNumber: phoneNumber,
          fromNumber: sipPhone.phoneNumber,
          externalCallId: result.conversationId || result.callId || null,
          elevenlabsConversationId: result.conversationId || null,
          status: 'initiated',
          startedAt: new Date(),
          metadata: {
            source: 'flow_test',
            flowId: flow.id,
            flowName: flow.name,
            testCall: true,
            conversationId: result.conversationId,
          },
        }).returning();

        // Check if a call_initiation_failure webhook arrived before this record was created (race condition)
        if (result.conversationId) {
          const pendingFailure = consumePendingFailure(result.conversationId);
          if (pendingFailure) {
            logger.error(`⚠️ [Flow Test] Applying pending failure for conversation ${result.conversationId}: ${pendingFailure.failure_reason}`);
            await db.execute(sql`
              UPDATE sip_calls SET 
                status = 'failed',
                ended_at = NOW(),
                metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
              failureReason: pendingFailure.failure_reason,
              failureMetadata: pendingFailure.metadata,
            })}::jsonb
              WHERE id = ${insertedSipCall.id}
            `);
            // Return error to client since the call failed
            throw new FlowTestHttpError(400, {
              error: "Call initiation failed",
              message: `ElevenLabs rejected the call: ${pendingFailure.failure_reason}`,
            });
          }
        }

        // Create flow execution record
        await db.insert(flowExecutions).values({
          id: nanoid(),
          companyId,
          callId: insertedSipCall.id,
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
            telephonyProvider: 'elevenlabs-sip',
            testCall: true,
            conversationId: result.conversationId,
          },
        });

        await completeQueue(insertedSipCall.id);
        return {
          success: true,
          callId: insertedSipCall.id,
          conversationId: result.conversationId,
          callSid: result.callId,
          flowId: flow.id,
          flowName: flow.name,
          fromNumber: sipPhone.phoneNumber,
          toNumber: phoneNumber,
          message: "Test call initiated successfully via ElevenLabs SIP Trunk. The agent will execute the workflow.",
          engine: 'elevenlabs_sip',
        };

      } catch (sipError: any) {
        console.error(`❌ [Flow Test] ElevenLabs SIP call error:`, sipError);
        throw new FlowTestHttpError(400, {
          error: "SIP call initiation failed",
          message: "Failed to initiate call via ElevenLabs SIP Trunk",
        });
      }
    }

    // ========================================
    // SIMPLE PHONE NUMBER SELECTION (for non-SIP engines)
    // Match agent's telephonyProvider to the correct phone table
    // ========================================

    let fromPhone: any = await selectFlowTestFromPhone({ userId, companyId, flow, agent, phoneNumber, queueEntryId, failQueue });

    // ========================================
    // CHECK FOR ACTIVE CAMPAIGN WARNING
    // Warn user if selected phone is attached to an active/running campaign
    // ========================================
    const activeCampaignWarning = await findFlowTestCampaignWarning({ companyId, fromPhone });

    // ========================================
    // CUSTOM VOICE ENGINE PATH
    // ========================================
    if (agent.telephonyProvider === 'custom-voice-engine') {
      return await placeCustomVoiceEngineFlowTestCall({ userId, companyId, flow, agent, phoneNumber, clientIp, fromPhone, activeCampaignWarning, completeQueue, failQueue });
    }

    // Check if this is an OpenAI-based flow agent (Plivo or Twilio+OpenAI)
    // OpenAI providers use twilioOpenaiCalls table, ElevenLabs uses calls table
    const isOpenAIProvider = agent.telephonyProvider === 'plivo' || agent.telephonyProvider === 'twilio_openai';

    // Only create calls table record for ElevenLabs provider
    // OpenAI provider creates its own record in twilioOpenaiCalls table via TwilioOpenAICallService
    let callId: string | null = null;
    let callRecord: any = null;

    if (!isOpenAIProvider) {
      callId = nanoid();
      const [record] = await db
        .insert(calls)
        .values({
          id: callId,
          userId: userId,
          companyId,
          agentId: agent.id,
          campaignId: null,
          contactId: null,
          phoneNumber: phoneNumber,
          fromNumber: fromPhone.phoneNumber,
          toNumber: phoneNumber,
          status: "initiated",
          callDirection: "outgoing",
          startedAt: new Date(),
          metadata: {
            source: "flow_test",
            flowId: flow.id,
            flowName: flow.name,
            fromNumber: fromPhone.phoneNumber,
            testCall: true,
            clientIp: clientIp,
          }
        })
        .returning();
      callRecord = record;

      // NOTE: pathTaken is left empty because ElevenLabs runs flows natively and
      // does not provide step-by-step execution telemetry. The UI will explain this
      // limitation and emphasize reliable data (variables, AI summary).
      const executionId = nanoid();
      await db.insert(flowExecutions).values({
        id: executionId,
        companyId,
        callId: callRecord.id,
        flowId: flow.id,
        currentNodeId: null,
        status: "running",
        variables: {},
        pathTaken: [],
        metadata: {
          testCall: true,
          phoneNumber,
          nativeElevenLabsExecution: true,
        }
      });
    }

    if (isOpenAIProvider) {
      if (!agent.openaiVoice) {
        throw new FlowTestHttpError(400, {
          error: "Flow agent missing OpenAI voice configuration",
          message: "Please select an OpenAI voice for this Flow agent in the Agents section.",
        });
      }
    } else {
      if (!agent.elevenLabsAgentId) {
        throw new FlowTestHttpError(400, {
          error: "Agent not synced with ElevenLabs",
          message: "Please configure and sync the agent in the Agents section first.",
        });
      }
      if (agent.type === 'flow' && !agent.elevenLabsVoiceId) {
        throw new FlowTestHttpError(400, {
          error: "Flow agent missing voice configuration",
          message: "Please select a voice for this Flow agent in the Agents section.",
        });
      }
      if (!fromPhone.elevenLabsPhoneNumberId) {
        throw new FlowTestHttpError(400, {
          error: "Phone number not synced with ElevenLabs",
          message: "Please sync your phone numbers with ElevenLabs in the Phone Numbers section before making test calls.",
        });
      }
    }

    if (!flow.nodes || !Array.isArray(flow.nodes) || flow.nodes.length === 0) {
      throw new FlowTestHttpError(400, {
        error: "Flow has no nodes defined",
        message: "Please add nodes to your flow in the visual flow builder.",
      });
    }

    if (!flow.edges || !Array.isArray(flow.edges)) {
      throw new FlowTestHttpError(400, {
        error: "Flow has no edges defined",
        message: "Please connect nodes in your flow in the visual flow builder.",
      });
    }

    logger.info(`🔀 [Flow Test] Flow validation passed`);
    logger.info(`   Nodes: ${flow.nodes.length}`);
    logger.info(`   Edges: ${flow.edges.length}`);

    // Route to appropriate call service based on agent's telephonyProvider
    if (agent.telephonyProvider === 'plivo') {
      return await placePlivoFlowTestCall({ userId, companyId, flow, agent, phoneNumber, activeCampaignWarning, completeQueue });
    }

    if (agent.telephonyProvider === 'twilio_openai') {
      return await placeTwilioOpenAIFlowTestCall({ userId, companyId, flow, agent, phoneNumber, fromPhone, activeCampaignWarning, completeQueue, failQueue });
    }

    // ========================================
    // ELEVENLABS PATH (Default)
    // ========================================
    // PROVIDER GUARD: Explicitly verify this is an ElevenLabs agent before proceeding
    // This prevents provider mismatch if earlier branches fail or fall through
    if (agent.telephonyProvider && ['plivo', 'twilio_openai', 'custom-voice-engine'].includes(agent.telephonyProvider)) {
      console.error(`❌ [Flow Test] Provider mismatch - agent is ${agent.telephonyProvider} but reached ElevenLabs path`);
      throw new FlowTestHttpError(400, {
        error: "Provider mismatch",
        message: `This agent uses ${agent.telephonyProvider} but the test call routing failed. Please try again.`,
      });
    }

    const elevenLabsPhone = await prepareElevenLabsTestPhone({ userId, companyId, agent, fromPhone });
    fromPhone = elevenLabsPhone.fromPhone;

    const { conversationId, callSid } = await placeElevenLabsTestCall({ companyId, flow, agent, phoneNumber, credential: elevenLabsPhone.credential, currentPhoneElevenLabsId: elevenLabsPhone.currentPhoneElevenLabsId, callId, callRecord });

    logger.info(`✅ [Flow Test] Test call initiated successfully`);
    logger.info(`   Call ID: ${callRecord.id}`);
    logger.info(`   Conversation ID: ${conversationId}`);
    logger.info(`   Flow: ${flow.name} (${flow.id})`);
    logger.info(`   From: [redacted] -> To: [redacted]`);

    await completeQueue(callRecord.id);
    return {
      success: true,
      callId: callRecord.id,
      conversationId: conversationId,
      twilioSid: callSid,
      flowId: flow.id,
      flowName: flow.name,
      fromNumber: fromPhone.phoneNumber,
      toNumber: phoneNumber,
      message: "Test call initiated successfully via ElevenLabs. The agent will execute the workflow natively.",
      ...(activeCampaignWarning && { warning: activeCampaignWarning }),
    };
  } catch (error: any) {
    if (error instanceof FlowTestHttpError) throw error;
    console.error("Error testing flow:", error);
    await failQueue(error?.message || "Test call failed");
    throw new FlowTestHttpError(500, { error: "Failed to test flow" });
  }
}

export function registerFlowTestCallRoutes(router: Router): void {
  // ── POST /flows/:id/test ──────────────────────────────────────────────────────
  router.post("/flows/:id/test", async (req: AuthRequest, res: Response) => {
    if (!req.userId) return res.status(401).json({ error: "Unauthorized" });
    const companyId = companyForRead(req, res);
    if (!companyId) return;
    const { phoneNumber, queueEntryId } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number is required" });
    if (!phoneNumber.startsWith("+") || phoneNumber.length < 11) {
      return res.status(400).json({
        error: "Invalid phone number format. Must be in E.164 format (e.g., +12025551234)",
      });
    }

    const clientIp = String(req.ip || req.socket.remoteAddress || 'unknown');
    const limitCheck = await checkDemoCallLimit(req.userId, clientIp);
    if (!limitCheck.allowed) {
      return res.status(429).json({
        error: "Limit Exceeded",
        message: limitCheck.message || "Daily call limit reached under the demo account."
      });
    }

    try {
      const result = await placeFlowTestCall({
        userId: req.userId,
        companyId,
        flowId: req.params.id,
        toPhone: phoneNumber,
        queueEntryId,
        clientIp,
      });

      // Log successful call to demo limit logs
      await logDemoCall(req.userId, clientIp);

      return res.json(result);
    } catch (err: any) {
      if (err instanceof FlowTestHttpError) {
        return res.status(err.statusCode).json(err.body);
      }
      console.error("Error testing flow:", err);
      return res.status(500).json({ error: "Failed to test flow" });
    }
  });
}
