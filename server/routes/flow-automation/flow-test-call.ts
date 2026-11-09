/** Flow test-call helper (placeFlowTestCall) and POST /flows/:id/test route. */
import { Router, Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { flows, flowExecutions, flowTestQueue, phoneNumbers, calls, agents, contacts, plivoPhoneNumbers, sipPhoneNumbers, sipCalls } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { checkDemoCallLimit, logDemoCall } from "../../demo-mode";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { FlowAgentService } from "../../services/flow-agent";
import { OutboundCallService } from "../../services/outbound-call-service";
import { PhoneMigrator } from "../../engines/elevenlabs-migration";
import { TwilioOpenAICallService } from "../../engines/twilio-openai/services/twilio-openai-call.service";
import { PlivoCallService } from "../../engines/plivo/services/plivo-call.service";
import { OpenAIAgentFactory } from "../../engines/plivo/services/openai-agent-factory";
import { type CompiledFlowConfig } from "../../engines/plivo/types";
import { getPluginStatus } from "../../plugins/loader";
import { consumePendingFailure } from "../webhook-routes";
import { logger } from "../../utils/logger";
import { companyForRead, buildFlowAgentBasePrompt } from "./shared";
import { FlowTestHttpError } from "./flow-test-call-types";
import { selectFlowTestFromPhone, findFlowTestCampaignWarning } from "./flow-test-call-phone";
import { placeCustomVoiceEngineFlowTestCall } from "./flow-test-call-custom-voice";

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
          console.warn(`⚠️ [Flow Test] Error creating flow execution:`, flowExecError.message);
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
        console.error(`❌ [Flow Test] Plivo call error:`, plivoError);
        throw new FlowTestHttpError(400, {
          error: "Call initiation failed",
          message: "Failed to initiate call via Plivo",
        });
      }
    }

    if (agent.telephonyProvider === 'twilio_openai') {
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
          console.error(`❌ [Flow Test] Twilio+OpenAI call initiation failed:`, callResult.error);
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
            console.warn(`⚠️ [Flow Test] Error creating flow execution:`, flowExecError.message);
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
        console.error(`❌ [Flow Test] Twilio+OpenAI call error:`, openaiError);
        await failQueue("Failed to initiate call via Twilio+OpenAI");
        throw new FlowTestHttpError(400, {
          error: "Call initiation failed",
          message: "Failed to initiate call via Twilio+OpenAI",
        });
      }
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

    logger.info(`   Using ElevenLabs native outbound call API`);

    const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
    if (!credential) {
      throw new FlowTestHttpError(400, {
        error: "No ElevenLabs credential available",
        message: "Please configure ElevenLabs API keys in the admin settings.",
      });
    }

    let currentPhoneElevenLabsId = fromPhone.elevenLabsPhoneNumberId;

    if (!agent.elevenLabsCredentialId) {
      throw new FlowTestHttpError(400, {
        error: "Agent not assigned to credential",
        message: "This agent is not assigned to an ElevenLabs credential. Please configure ElevenLabs credentials in admin settings.",
      });
    }

    const isSystemPoolNumber = fromPhone.isSystemPool === true && fromPhone.userId === null;
    if (!isSystemPoolNumber && fromPhone.userId !== userId) {
      console.warn(`⚠️ [Flow Test] Phone ${fromPhone.id} does not belong to user ${userId}`);
      throw new FlowTestHttpError(403, {
        error: "Phone number access denied",
        message: "You do not have access to this phone number.",
      });
    }

    // If phone lacks credential, try full migration via PhoneMigrator
    // PhoneMigrator handles proper credential ownership verification and ElevenLabs sync
    if (!fromPhone.elevenLabsCredentialId) {
      logger.warn(`📞 [Flow Test] Phone missing credential - attempting full sync via PhoneMigrator`);
      try {
        const migrationResult = await PhoneMigrator.syncPhoneToAgentCredential(
          fromPhone.id,
          agent.id
        );

        if (migrationResult.success && migrationResult.newElevenLabsPhoneId) {
          logger.info(`✅ [Flow Test] Phone synced successfully via PhoneMigrator`);
          currentPhoneElevenLabsId = migrationResult.newElevenLabsPhoneId;
          // Re-fetch updated phone record to ensure we have correct state
          const [updatedPhone] = await db
            .select()
            .from(phoneNumbers)
            .where(and(eq(phoneNumbers.id, fromPhone.id), eq(phoneNumbers.companyId, companyId)))
            .limit(1);
          if (updatedPhone) {
            fromPhone = updatedPhone;
          }
          // Validate refreshed phone has expected credential after sync
          if (!fromPhone.elevenLabsCredentialId || !fromPhone.elevenLabsPhoneNumberId) {
            console.error(`❌ [Flow Test] Phone sync returned success but DB state invalid`);
            throw new FlowTestHttpError(500, {
              error: "Phone sync inconsistent",
              message: "Phone sync reported success but database state is invalid. Please try again.",
            });
          }
        } else {
          throw new FlowTestHttpError(400, {
            error: "Phone not synced with ElevenLabs",
            message: "This phone number could not be synced with ElevenLabs. Please try syncing from the Phone Numbers page, or purchase a new phone number.",
            suggestion: "Visit Phone Numbers page and click 'Sync to ElevenLabs' for this number.",
          });
        }
      } catch (syncError: any) {
        if (syncError instanceof FlowTestHttpError) throw syncError;
        console.error(`❌ [Flow Test] Phone sync failed:`, syncError);
        throw new FlowTestHttpError(400, {
          error: "Phone sync failed",
          message: "Failed to sync phone number with ElevenLabs. Please try again or purchase a new phone number.",
        });
      }
    } else if (fromPhone.elevenLabsCredentialId !== agent.elevenLabsCredentialId) {
      logger.info(`📞 [Flow Test] Phone credential mismatch detected - initiating migration`);
      logger.info(`   Phone credential: ${fromPhone.elevenLabsCredentialId}`);
      logger.info(`   Agent credential: ${agent.elevenLabsCredentialId}`);

      try {
        const migrationResult = await PhoneMigrator.syncPhoneToAgentCredential(
          fromPhone.id,
          agent.id
        );

        if (!migrationResult.success) {
          console.error(`❌ [Flow Test] Phone migration failed:`, migrationResult.error);
          throw new FlowTestHttpError(400, {
            error: "Phone number migration failed",
            message: "Could not migrate phone number to agent's credential",
          });
        }

        logger.info(`✅ [Flow Test] Phone migrated successfully`);
        logger.info(`   Old ElevenLabs ID: ${migrationResult.oldElevenLabsPhoneId}`);
        logger.info(`   New ElevenLabs ID: ${migrationResult.newElevenLabsPhoneId}`);

        if (!migrationResult.newElevenLabsPhoneId) {
          throw new FlowTestHttpError(400, {
            error: "Phone number migration incomplete",
            message: "Migration succeeded but new ElevenLabs phone ID was not returned",
          });
        }
        currentPhoneElevenLabsId = migrationResult.newElevenLabsPhoneId;

      } catch (migrationError: any) {
        if (migrationError instanceof FlowTestHttpError) throw migrationError;
        console.error(`❌ [Flow Test] Phone migration error:`, migrationError);
        throw new FlowTestHttpError(500, {
          error: "Phone number migration failed",
          message: "Failed to migrate phone number to agent's credential",
        });
      }
    } else {
      logger.info(`✅ [Flow Test] Phone and agent on same credential: ${agent.elevenLabsCredentialId}`);
    }

    // PRE-FLIGHT CHECK 2: Verify phone actually exists on ElevenLabs
    // The database may have a stale elevenLabsPhoneNumberId that no longer exists
    logger.info(`📞 [Flow Test] Verifying phone exists on ElevenLabs...`);
    const verifyResult = await PhoneMigrator.verifyAndEnsurePhoneExists(
      fromPhone.id,
      agent.elevenLabsCredentialId,
      agent.elevenLabsAgentId || undefined // Pass agent ID for assignment after re-import
    );

    if (!verifyResult.success) {
      console.error(`❌ [Flow Test] Phone verification failed:`, verifyResult.error);
      throw new FlowTestHttpError(400, {
        error: "Phone number not available on ElevenLabs",
        message: verifyResult.error || "Could not verify or re-import phone number. Please check your Twilio configuration.",
      });
    }

    if (verifyResult.wasReimported) {
      logger.info(`✅ [Flow Test] Phone was re-imported from Twilio`);
      logger.info(`   New ElevenLabs ID: ${verifyResult.elevenLabsPhoneId}`);
    }

    // Use the verified (or re-imported) phone ID
    currentPhoneElevenLabsId = verifyResult.elevenLabsPhoneId!;

    // Create OutboundCallService with the agent's credential (separate from ElevenLabsService)
    const outboundCallService = new OutboundCallService(credential.apiKey);

    let conversationId: string;
    let callSid: string | undefined;

    try {
      logger.info(`📞 [Flow Test] Initiating test call via ElevenLabs Twilio API`);
      logger.info(`   From Phone (ElevenLabs ID): ${currentPhoneElevenLabsId}`);
      logger.info(`   To: [redacted]`);
      logger.info(`   Agent (ElevenLabs ID): ${agent.elevenLabsAgentId}`);
      logger.info(`   Flow ID: ${flow.id}`);

      // Compile the flow at runtime for ElevenLabs test calls
      // This ensures we test the current state of the flow in the builder, even if not yet "published"
      let testNodes = (flow.nodes || []) as import('@shared/schema').FlowNode[];
      const testEdges = (flow.edges || []) as import('@shared/schema').FlowEdge[];

      // Enrich form nodes with field definitions from database before compiling
      testNodes = await FlowAgentService.enrichFormNodesWithFields(testNodes);

      // Validate transfer nodes before starting test call to prevent premature hang-ups
      for (const node of testNodes) {
        const rawNode = node as any;
        const nodeType = rawNode.type || rawNode.data?.type || '';
        if (nodeType === 'transfer' || nodeType === 'transfer_call' || nodeType === 'phone_transfer') {
          const config = rawNode.data?.config || rawNode.data || {};
          const transferNumber = String(config.transferNumber || config.phoneNumber || config.number || rawNode.data?.transferNumber || rawNode.data?.phoneNumber || rawNode.data?.number || '');
          const cleanNumber = transferNumber.replace(/\D/g, '');
          const placeholders = ['1234567890', '1234567891', '1234567892', '12345678901', '12345678902'];
          if (!transferNumber || transferNumber.trim() === '' || placeholders.includes(cleanNumber) || cleanNumber.length < 10) {
            const errorMsg = `Please configure a valid phone number for the transfer node "${rawNode.data?.label || rawNode.id || 'Transfer Call'}". Found placeholder/invalid number: "${transferNumber}".`;
            throw new FlowTestHttpError(400, {
              error: errorMsg,
              message: errorMsg
            });
          }
        }
      }

      const compileResult = FlowAgentService.compileFlow(testNodes, testEdges);
      const { workflow: testWorkflow, firstMessage: flowFirstMessageResult, hasAppointmentNodes, hasFormNodes, formNodes, hasWebhookNodes, webhookNodes } = compileResult;

      logger.info(`   Compiled temporary workflow: ${Object.keys(testWorkflow.nodes).length} nodes, ${Object.keys(testWorkflow.edges).length} edges`);

      // Extract contact variable placeholders from flow's compiled first message, agent first message, or flow nodes
      // For test calls without a contact, we need to pass placeholder dynamic_data
      // Priority: flow's extracted message (most accurate) > compiledFirstMessage (pre-saved) > agent.firstMessage
      let flowFirstMessage = '';

      if (flowFirstMessageResult) {
        flowFirstMessage = flowFirstMessageResult;
      } else if (flow.compiledFirstMessage) {
        flowFirstMessage = flow.compiledFirstMessage as string;
      } else {
        // Fallback: look for first message node in flow nodes
        const flowFirstMessageNode = (flow.nodes as any[]).find((n: any) => n.type === 'message');
        if (flowFirstMessageNode?.data?.config?.message) {
          flowFirstMessage = flowFirstMessageNode.data.config.message;
        } else if (flowFirstMessageNode?.data?.message) {
          flowFirstMessage = flowFirstMessageNode.data.message;
        } else {
          // Final fallback: agent's first message
          flowFirstMessage = agent.firstMessage || '';
        }
      }

      // Look up contact by phoneNumber (matching last 10 digits) to get real name if exists
      const digits = phoneNumber.replace(/\D/g, '');
      let contactRecord: any = null;
      if (digits.length >= 10) {
        const last10 = digits.slice(-10);
        const [foundContact] = await db
          .select()
          .from(contacts)
          .where(and(sql`${contacts.phone} LIKE ${'%' + last10}`, eq(contacts.companyId, companyId)))
          .limit(1);
        if (foundContact) {
          contactRecord = foundContact;
          logger.info(`   📞 [Flow Test] Found contact in database for Twilio test: ${contactRecord.firstName} ${contactRecord.lastName || ''}`);
        }
      }

      const dynamicData: Record<string, string> = {};
      if (contactRecord) {
        const fullName = (contactRecord.firstName + ' ' + (contactRecord.lastName || '')).trim();
        dynamicData['contact_name'] = fullName;
        dynamicData['name'] = fullName;
        dynamicData['contact_first_name'] = contactRecord.firstName || '';
        dynamicData['first_name'] = contactRecord.firstName || '';
        dynamicData['firstName'] = contactRecord.firstName || '';
        dynamicData['contact_last_name'] = contactRecord.lastName || '';
        dynamicData['last_name'] = contactRecord.lastName || '';
        dynamicData['lastName'] = contactRecord.lastName || '';
        dynamicData['contact_phone'] = phoneNumber;
        dynamicData['phone'] = phoneNumber;
        if (contactRecord.email) {
          dynamicData['contact_email'] = contactRecord.email;
          dynamicData['email'] = contactRecord.email;
        }
        if (contactRecord.customFields && typeof contactRecord.customFields === 'object') {
          for (const [key, val] of Object.entries(contactRecord.customFields)) {
            if (val !== null && val !== undefined) {
              dynamicData[key] = String(val);
            }
          }
        }
      } else {
        dynamicData['contact_name'] = 'Test User';
        dynamicData['name'] = 'Test User';
        dynamicData['contact_first_name'] = 'Test';
        dynamicData['first_name'] = 'Test';
        dynamicData['firstName'] = 'Test';
        dynamicData['contact_last_name'] = 'User';
        dynamicData['last_name'] = 'User';
        dynamicData['lastName'] = 'User';
        dynamicData['contact_phone'] = phoneNumber;
        dynamicData['phone'] = phoneNumber;
        dynamicData['contact_email'] = 'test@example.com';
        dynamicData['email'] = 'test@example.com';
      }

      // Extract {{variable_name}} patterns from the message
      const variablePattern = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
      let match;
      while ((match = variablePattern.exec(flowFirstMessage)) !== null) {
        const varName = match[1];
        if (!dynamicData[varName]) {
          dynamicData[varName] = `[${varName}]`;
        }
      }

      // Always ensure contact_phone is in dynamic vars — prevents the agent asking
      // the caller for their own number during form collection.
      if (!dynamicData.contact_phone && !dynamicData.phone) {
        dynamicData.contact_phone = phoneNumber;
      }

      if (Object.keys(dynamicData).length > 0) {
        logger.info(`   📝 Passing dynamic_data to outbound call:`, JSON.stringify(dynamicData));
      }

      // Build necessary webhook tools for test execution
      let testWebhookTools: any[] = [];
      const { buildMessagingEmailTool, buildMessagingWhatsappTool } = await import('../services/elevenlabs');

      if (hasWebhookNodes && webhookNodes && webhookNodes.length > 0) {
        for (const webhookNode of webhookNodes) {
          if (webhookNode.toolId.startsWith('send_email_') && !webhookNode.url) {
            const templateName = webhookNode.payload?.template_name || 'default';
            const emailTool = buildMessagingEmailTool(agent.elevenLabsAgentId!, [templateName], templateName);
            emailTool.name = webhookNode.toolId;
            testWebhookTools.push(emailTool);
            logger.info(`   📧 Prepared test email tool: ${webhookNode.toolId}`);
          } else if (webhookNode.toolId.startsWith('send_whatsapp') && !webhookNode.url) {
            const templateName = webhookNode.payload?.template_name || 'hello_world';
            const whatsappTool = buildMessagingWhatsappTool(agent.elevenLabsAgentId!, [templateName], templateName, undefined, "auto");
            whatsappTool.name = webhookNode.toolId;
            testWebhookTools.push(whatsappTool);
            logger.info(`   💬 Prepared test WhatsApp tool: ${webhookNode.toolId}`);
          } else if (webhookNode.url) {
            const { buildUniversalWebhookTool } = await import('../services/universal-webhook-tool');
            const webhookTool = buildUniversalWebhookTool({
              toolId: webhookNode.toolId,
              url: webhookNode.url,
              method: webhookNode.method || 'POST',
              headers: webhookNode.headers,
              payload: webhookNode.payload
            });
            testWebhookTools.push(webhookTool);
            logger.info(`   🔗 Prepared test universal webhook tool: ${webhookNode.toolId}`);
          }
        }
      }

      if (hasFormNodes && formNodes && formNodes.length > 0) {
        const { getSubmitFormWebhookTool } = await import('../services/form-elevenlabs-tool');
        for (const formInfo of formNodes) {
          const formTool = getSubmitFormWebhookTool(
            formInfo.formId,
            formInfo.formName,
            formInfo.fields,
            agent.elevenLabsAgentId!,
            formInfo.nodeId
          );
          testWebhookTools.push(formTool);
          logger.info(`   📋 Prepared test form tool: ${formInfo.formName}`);
        }
      }

      if (hasAppointmentNodes) {
        const { getAppointmentToolForAgent } = await import('../services/appointment-elevenlabs-tool');
        const appointmentTool = getAppointmentToolForAgent(agent.elevenLabsAgentId!);
        testWebhookTools.push(appointmentTool);
        logger.info(`   📅 Prepared test appointment tool`);
      }

      // ── PRE-FLIGHT: Push recompiled workflow to ElevenLabs agent ──
      // ElevenLabs ignores conversation_config_override.workflow for outbound calls
      // (the agent always uses its saved workflow). So we PATCH the agent first.
      logger.info(`   🔄 Pushing recompiled workflow to ElevenLabs agent before call...`);
      try {
        const elevenlabsService = new (await import('../services/elevenlabs')).ElevenLabsService(credential.apiKey);
        await elevenlabsService.updateFlowAgentWorkflow(
          agent.elevenLabsAgentId!,
          testWorkflow,
          agent.maxDurationSeconds || 900,
          agent.detectLanguageEnabled || false,
          agent.language || undefined,
          undefined, // ttsModel
          undefined, // llmModel
          undefined, // temperature
          flowFirstMessage || undefined,
          undefined, // voiceId
          {
            webhookTools: testWebhookTools.length > 0 ? testWebhookTools : undefined,
            basePrompt: buildFlowAgentBasePrompt(agent.systemPrompt)
          }
        );
        logger.info(`   ✅ Agent workflow updated on ElevenLabs (${Object.keys(testWorkflow.nodes).length} nodes, ${testWebhookTools.length} tools)`);
      } catch (updateError: any) {
        console.error(`   ⚠️ Failed to update agent workflow (call may use stale workflow):`, updateError.message);
      }

      // Use OutboundCallService for ElevenLabs Twilio outbound calls
      // Note: workflow override removed — ElevenLabs uses the agent's saved workflow (updated above)
      const result = await outboundCallService.initiateCall({
        agentId: agent.elevenLabsAgentId!,
        agentPhoneNumberId: currentPhoneElevenLabsId!,
        toNumber: phoneNumber,
        firstMessage: flowFirstMessage || undefined,
        dynamicData,
      });

      logger.info(`✅ [Flow Test Call] Call initiated:`, JSON.stringify(result));

      if (!result.success) {
        throw new FlowTestHttpError(400, {
          error: "Failed to initiate outbound call",
          message: result.message || "ElevenLabs failed to initiate the outbound call. Please check your Twilio credentials and configuration."
        });
      }

      conversationId = result.conversationId || '';
      callSid = result.callSid || undefined;

      // CRITICAL: Update the call record with the ElevenLabs conversation ID immediately
      // This allows the WhatsApp webhook (which hits during the call) to find the phone number
      if (conversationId && callId) {
        try {
          const { sql } = await import('drizzle-orm');
          await db.execute(sql`
            UPDATE calls 
            SET elevenlabs_conversation_id = ${conversationId},
                twilio_sid = ${callSid || null}
            WHERE id = ${callId}
          `);
          logger.info(`   ✅ Call record ${callId} updated with ElevenLabs conversation ID: ${conversationId}`);
        } catch (dbError: any) {
          console.error(`   ⚠️ Failed to update call record with conversation ID:`, dbError.message);
        }
      }

      logger.info(`✅ [Flow Test] ElevenLabs outbound call initiated`);
      logger.info(`   Conversation ID: ${conversationId}`);
      if (callSid) {
        logger.info(`   Call SID: ${callSid}`);
      }

      // Create flow execution record for ElevenLabs test call
      if (callId) {
        try {
          await db.insert(flowExecutions).values({
            id: nanoid(),
            companyId,
            callId: callId,
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
              telephonyProvider: 'elevenlabs',
              testCall: true,
              conversationId: conversationId,
            },
          });
          logger.info(`🔀 [Flow Test] Created flow execution for ElevenLabs test call`);
        } catch (flowExecError: any) {
          console.warn(`⚠️ [Flow Test] Error creating flow execution:`, flowExecError.message);
        }
      }

      // Update call record with ElevenLabs conversation ID and Twilio SID
      // Note: callId is guaranteed to be set in ElevenLabs path (we only reach here when !isOpenAIProvider)
      const existingMetadata = (callRecord.metadata ?? {}) as import('@shared/schema').CallMetadata;
      await db
        .update(calls)
        .set({
          twilioSid: callSid || null,
          elevenLabsConversationId: conversationId,
          metadata: {
            ...existingMetadata,
            elevenLabsNative: true,
            conversationId: conversationId,
          }
        })
        .where(eq(calls.id, callId!));

    } catch (elevenLabsError: any) {
      if (elevenLabsError instanceof FlowTestHttpError) throw elevenLabsError;
      console.error(`❌ [Flow Test] ElevenLabs call initiation failed:`, elevenLabsError);

      const failedMetadata = (callRecord.metadata ?? {}) as import('@shared/schema').CallMetadata;
      await db
        .update(calls)
        .set({
          status: 'failed',
          endedAt: new Date(),
          metadata: { ...failedMetadata, error: 'ElevenLabs call initiation failed' },
        })
        .where(eq(calls.id, callId!));

      throw new FlowTestHttpError(400, {
        error: "Call initiation failed",
        message: "Failed to initiate call via ElevenLabs",
      });
    }

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
