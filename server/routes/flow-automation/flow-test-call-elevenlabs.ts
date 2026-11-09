/** ElevenLabs test-call path (phone pre-flight and outbound call), moved out of placeFlowTestCall unchanged. */
import { db } from "../../db";
import { flowExecutions, phoneNumbers, calls, contacts } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { FlowAgentService } from "../../services/flow-agent";
import { OutboundCallService } from "../../services/outbound-call-service";
import { PhoneMigrator } from "../../engines/elevenlabs-migration";
import { logger } from "../../utils/logger";
import { buildFlowAgentBasePrompt } from "./shared";
import { FlowTestHttpError, type FlowTestAgent, type FlowTestFlow, type FlowTestElevenLabsCredential } from "./flow-test-call-types";

export async function prepareElevenLabsTestPhone({
  userId,
  companyId,
  agent,
  fromPhone,
}: {
  userId: string;
  companyId: string;
  agent: FlowTestAgent;
  fromPhone: any;
}) {
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
  return { credential, fromPhone, currentPhoneElevenLabsId };
}

export async function placeElevenLabsTestCall({
  companyId,
  flow,
  agent,
  phoneNumber,
  credential,
  currentPhoneElevenLabsId,
  callId,
  callRecord,
}: {
  companyId: string;
  flow: FlowTestFlow;
  agent: FlowTestAgent;
  phoneNumber: string;
  credential: FlowTestElevenLabsCredential;
  currentPhoneElevenLabsId: any;
  callId: string | null;
  callRecord: any;
}) {
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
  return { conversationId, callSid };
}
