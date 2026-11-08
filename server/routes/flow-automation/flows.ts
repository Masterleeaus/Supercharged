/** Flow CRUD and first-message resync routes. */
import { Router, Response } from "express";
import { db } from "../../db";
import { type AuthRequest } from "../../middleware/auth";
import { flows, createFlowSchema, webhooks, appointments, forms, formFields, flowExecutions, flowTestQueue, agents } from "@shared/schema";
import { eq, and, or, desc, sql, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { storage } from "../../storage";
import { ElevenLabsService } from "../../services/elevenlabs";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { FlowAgentService } from "../../services/flow-agent";
import { OpenAIVoiceAgentCompiler, type FlowNode, type FlowEdge } from "../../services/openai-voice-agent";
import { logger } from "../../utils/logger";
import { companyForRead, FLOW_EDITABLE_FIELDS, pickEditableFields, buildFlowAgentBasePrompt } from "./shared";

export function registerFlowRoutes(router: Router): void {
  router.get("/flows", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;

      const userFlows = await db
        .select()
        .from(flows)
        .where(and(eq(flows.userId, userId), eq(flows.companyId, companyId)))
        .orderBy(desc(flows.updatedAt));

      res.json(userFlows);
    } catch (error: any) {
      console.error("Error fetching flows:", error);
      res.status(500).json({ error: "Failed to fetch flows" });
    }
  });

  router.get("/flows/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;

      const [flow] = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, id), eq(flows.userId, userId), eq(flows.companyId, companyId)));

      if (!flow) {
        return res.status(404).json({ error: "Flow not found" });
      }

      res.json(flow);
    } catch (error: any) {
      console.error("Error fetching flow:", error);
      res.status(500).json({ error: "Failed to fetch flow" });
    }
  });

  router.post("/flows", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;

      // Check flow limit (999 or -1 means unlimited)
      const effectiveLimits = await storage.getUserEffectiveLimits(userId);
      const currentFlowCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(flows)
        .where(and(eq(flows.userId, userId), eq(flows.companyId, companyId)));

      const flowCount = Number(currentFlowCount[0]?.count || 0);
      // Ensure maxFlows is a concrete number (default to 3 if somehow undefined)
      const maxFlows = typeof effectiveLimits.maxFlows === 'number' ? effectiveLimits.maxFlows : 3;
      // Skip limit check if explicitly unlimited (999 or -1)
      if (maxFlows !== 999 && maxFlows !== -1 && flowCount >= maxFlows) {
        return res.status(403).json({
          error: "Flow limit reached",
          message: `You have reached your maximum of ${maxFlows} flows. Please upgrade your plan or delete existing flows.`,
          limit: maxFlows,
          current: flowCount
        });
      }

      const validatedData = createFlowSchema.parse(req.body);

      const flowId = nanoid();
      // TODO: Drizzle type inference - validatedData from Zod schema doesn't perfectly match
      // the insert type due to optional fields and defaults. Using explicit type assertion.
      const [newFlow] = await db
        .insert(flows)
        .values({
          id: flowId,
          userId,
          ...validatedData,
          companyId,
        } as typeof flows.$inferInsert)
        .returning();

      // Enforce 1-to-1 mapping on flow creation
      if (validatedData.agentId) {
        await db.update(flows)
          .set({ agentId: null })
          .where(
            and(
              eq(flows.agentId, validatedData.agentId),
              ne(flows.id, flowId)
            )
          );

        // Also ensure the agents table points to this flow
        await db.update(agents)
          .set({ flowId })
          .where(eq(agents.id, validatedData.agentId));

        // And for CVE agents specifically, update ve_voice_agents
        try {
          await db.execute(sql`UPDATE ve_voice_agents SET flow_id = ${flowId} WHERE id = ${validatedData.agentId}`);
        } catch (e) { /* ignore if column doesn't exist */ }
      }

      res.json(newFlow);
    } catch (error: any) {
      console.error("Error creating flow:", error);
      res.status(500).json({ error: "Failed to create flow" });
    }
  });

  router.patch("/flows/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;

      const editable = pickEditableFields(req.body, FLOW_EDITABLE_FIELDS);
      if (!editable) {
        return res.status(400).json({ error: "No editable fields in request body" });
      }

      const [existingFlow] = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, id), eq(flows.userId, userId), eq(flows.companyId, companyId)));

      if (!existingFlow) {
        return res.status(404).json({ error: "Flow not found" });
      }

      const [updatedFlow] = await db
        .update(flows)
        .set({
          ...editable,
          updatedAt: new Date(),
        })
        .where(eq(flows.id, id))
        .returning();

      // ── Google Sheets: auto-write header row on flow save ─────────────────────
      // Run fire-and-forget so a Sheets failure never blocks the save response.
      (async () => {
        try {
          const flowNodes = (updatedFlow.nodes || []) as any[];
          const formNodesWithSheet = flowNodes.filter((node: any) => {
            const nodeType = node.data?.type || node.type;
            if (nodeType !== 'form' && nodeType !== 'form_submission' && nodeType !== 'collect_info') return false;
            const cfg = node.data?.config || node.data || {};
            return !!cfg.googleSheetId;
          });

          if (formNodesWithSheet.length > 0) {
            const { ensureSheetHeaders, listSheetTabs } = await import('../services/google-sheets/google-sheets.service');

            for (const node of formNodesWithSheet) {
              const cfg = node.data?.config || node.data || {};
              const sheetId: string = cfg.googleSheetId;
              let sheetName: string = cfg.googleSheetName || '';
              const formId: string = cfg.formId;

              if (!formId) continue;

              // Resolve the worksheet tab name if not explicitly set
              if (!sheetName) {
                try {
                  const tabs = await listSheetTabs(userId, sheetId);
                  sheetName = tabs.length > 0 ? tabs[0].title : 'Sheet1';
                } catch {
                  sheetName = 'Sheet1';
                }
              }

              // Load form fields to build column header labels
              const fields = await db
                .select()
                .from(formFields)
                .where(and(eq(formFields.formId, formId), eq(formFields.companyId, companyId)))
                .orderBy(formFields.order);

              const headerRow = [
                'Contact Name',
                'Contact Phone',
                ...fields.map((f: any) => f.question || f.label || f.id),
                'Call ID',
                'Submitted At',
              ];

              const wrote = await ensureSheetHeaders(userId, sheetId, sheetName, headerRow);
              if (wrote) {
                logger.info(`📋 [Flow Save] Google Sheets header row written for form "${formId}" → sheet "${sheetName}" (${sheetId})`);
              }
            }
          }
        } catch (sheetErr: any) {
          console.warn(`📋 [Flow Save] Google Sheets header init failed (non-fatal):`, sheetErr.message);
        }
      })();
      // ──────────────────────────────────────────────────────────────────────────

      const flowAgentId = updatedFlow.agentId || editable.agentId;
      if (flowAgentId) {
        try {
          // Enforce 1-to-1 flow mapping: clear this agent from any other flows first
          await db.update(flows)
            .set({ agentId: null })
            .where(
              and(
                eq(flows.agentId, flowAgentId),
                ne(flows.id, id)
              )
            );

          // Also ensure the agents table points to this flow
          await db.update(agents)
            .set({ flowId: id })
            .where(eq(agents.id, flowAgentId));

          // And for CVE agents specifically, update ve_voice_agents
          try {
            await db.execute(sql`UPDATE ve_voice_agents SET flow_id = ${id} WHERE id = ${flowAgentId}`);
          } catch (e) { /* ignore if column doesn't exist */ }

          let agent = (await db
            .select()
            .from(agents)
            .where(and(eq(agents.id, flowAgentId), eq(agents.companyId, companyId))))[0];

          if (!agent) {
            const veAgentResult = await db.execute(sql`
            SELECT * FROM ve_voice_agents WHERE id = ${flowAgentId} LIMIT 1
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

          if (agent && (agent.type === 'flow' || agent.telephonyProvider === 'custom-voice-engine')) {
            // Check if this is an OpenAI-based or Custom Voice Engine flow agent
            const isOpenAIProvider =
              agent.telephonyProvider === 'plivo' ||
              agent.telephonyProvider === 'twilio_openai' ||
              agent.telephonyProvider === 'custom-voice-engine';

            if (isOpenAIProvider) {
              // OpenAI-based flow agents - compile flow using shared OpenAI Voice Agent service
              logger.info(`🔄 [Flow Save] OpenAI-based flow agent (${agent.telephonyProvider}) - compiling for OpenAI Realtime`);
              logger.info(`   Agent: ${agent.name} (${agent.id})`);
              logger.info(`   Flow: ${updatedFlow.name} (${updatedFlow.id})`);
              logger.info(`   Voice: ${agent.openaiVoice || 'alloy'}`);

              // Compile flow for OpenAI engines and store in database
              try {
                const flowNodes = (updatedFlow.nodes || []) as FlowNode[];
                const flowEdges = (updatedFlow.edges || []) as FlowEdge[];

                if (flowNodes.length > 0) {
                  const compiled = OpenAIVoiceAgentCompiler.compileFlow(flowNodes, flowEdges, {
                    language: agent.language || 'en',
                    voice: agent.openaiVoice || 'alloy',
                    model: (agent as any).llmModel || 'gpt-realtime-1.5',
                    agentName: agent.name,
                    agentPersonality: agent.systemPrompt || undefined,
                    knowledgeBaseIds: agent.knowledgeBaseIds || [],
                    transferPhoneNumber: agent.transferPhoneNumber || undefined,
                    transferEnabled: agent.transferEnabled || false,
                    endConversationEnabled: agent.endConversationEnabled ?? true,
                  });

                  await db.update(flows).set({
                    compiledSystemPrompt: compiled.systemPrompt,
                    compiledFirstMessage: compiled.firstMessage || null,
                    compiledStates: compiled.conversationStates,
                    compiledTools: compiled.tools,
                  }).where(eq(flows.id, id));

                  logger.info(`✅ [Flow Save] Compiled for OpenAI: ${compiled.conversationStates.length} states, ${compiled.tools.length} tools`);
                } else {
                  logger.warn(`⚠️ [Flow Save] Flow has no nodes, skipping OpenAI compilation`);
                }
              } catch (compileError: any) {
                console.error(`❌ [Flow Save] OpenAI compilation error:`, compileError.message);
              }
            } else {
              // ElevenLabs/Twilio flow agent - sync to ElevenLabs
              logger.info(`🔄 [Flow Save] Syncing Flow agent to ElevenLabs...`);
              logger.info(`   Agent: ${agent.name} (${agent.id})`);
              logger.info(`   Flow: ${updatedFlow.name} (${updatedFlow.id})`);

              if (!agent.elevenLabsVoiceId) {
                logger.warn(`⚠️ [Flow Save] Agent missing voice configuration, skipping ElevenLabs sync`);
              } else {
                const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
                if (!credential) {
                  logger.warn(`⚠️ [Flow Save] No ElevenLabs credential found for agent, skipping sync`);
                } else {
                  const elevenlabsService = new ElevenLabsService(credential.apiKey);

                  let flowNodes = (updatedFlow.nodes || []) as import('@shared/schema').FlowNode[];
                  const flowEdges = (updatedFlow.edges || []) as import('@shared/schema').FlowEdge[];

                  if (flowNodes.length > 0) {
                    // Enrich form nodes with field definitions from database before compiling
                    flowNodes = await FlowAgentService.enrichFormNodesWithFields(flowNodes);
                    const compileResult = FlowAgentService.compileFlow(flowNodes, flowEdges);
                    const { workflow: compiledWorkflow, firstMessage: flowFirstMessage, hasAppointmentNodes, hasFormNodes, formNodes, hasWebhookNodes, webhookNodes, hasPlayAudioNodes, playAudioNodes } = compileResult;

                    logger.info(`   Compiled workflow: ${Object.keys(compiledWorkflow.nodes).length} nodes, ${Object.keys(compiledWorkflow.edges).length} edges`);
                    if (flowFirstMessage) {
                      logger.info(`   First message from flow: "${flowFirstMessage.substring(0, 50)}..."`);
                    }
                    if (hasAppointmentNodes) {
                      logger.info(`   📅 Flow contains appointment nodes`);
                    }
                    if (hasFormNodes) {
                      logger.info(`   📋 Flow contains form nodes (${formNodes?.length || 0} forms)`);
                    }
                    if (hasWebhookNodes) {
                      logger.info(`   🔗 Flow contains webhook nodes (${webhookNodes?.length || 0} webhooks)`);
                    }
                    if (hasPlayAudioNodes) {
                      logger.info(`   🔊 Flow contains play audio nodes (${playAudioNodes?.length || 0} audio files)`);
                    }

                    if (!agent.elevenLabsAgentId) {
                      logger.info(`   Creating new ElevenLabs Flow agent...`);
                      const elevenLabsAgent = await elevenlabsService.createFlowAgent({
                        name: agent.name,
                        voice_id: agent.elevenLabsVoiceId,
                        language: agent.language || 'en',
                        maxDurationSeconds: agent.maxDurationSeconds || 900,
                        detectLanguageEnabled: agent.detectLanguageEnabled || false,
                        workflow: compiledWorkflow,
                        firstMessage: flowFirstMessage,
                      });

                      await db
                        .update(agents)
                        .set({ elevenLabsAgentId: elevenLabsAgent.agent_id })
                        .where(eq(agents.id, agent.id));

                      logger.info(`✅ [Flow Save] Created ElevenLabs agent: ${elevenLabsAgent.agent_id}`);

                      // Build webhook tools array for new agents
                      let newAgentWebhookTools: any[] = [];

                      // Add RAG tool if agent has knowledge bases assigned
                      if (agent.knowledgeBaseIds && agent.knowledgeBaseIds.length > 0) {
                        const { isRAGEnabled, getAskKnowledgeWebhookTool } = await import('../services/rag-elevenlabs-tool');
                        if (isRAGEnabled()) {
                          const ragTool = getAskKnowledgeWebhookTool(elevenLabsAgent.agent_id);
                          newAgentWebhookTools.push(ragTool);
                          logger.info(`📚 [Flow Save] Adding RAG knowledge tool to new agent`);
                        }
                      }

                      // Add appointment booking tool if flow has appointment nodes
                      if (hasAppointmentNodes) {
                        logger.info(`📅 [Flow Save] Adding appointment booking tool to agent ${elevenLabsAgent.agent_id}`);
                        const { getAppointmentToolForAgent } = await import('../services/appointment-elevenlabs-tool');
                        const appointmentTool = getAppointmentToolForAgent(elevenLabsAgent.agent_id);
                        newAgentWebhookTools.push(appointmentTool);
                      }

                      // Add form submission tools if flow has form nodes
                      if (hasFormNodes && formNodes && formNodes.length > 0) {
                        logger.info(`📋 [Flow Save] Adding form submission tools (${formNodes.length} forms) to agent ${elevenLabsAgent.agent_id}`);
                        const { getSubmitFormWebhookTool } = await import('../services/form-elevenlabs-tool');
                        for (const formInfo of formNodes) {
                          const formTool = getSubmitFormWebhookTool(
                            formInfo.formId,
                            formInfo.formName,
                            formInfo.fields,
                            elevenLabsAgent.agent_id,
                            formInfo.nodeId
                          );
                          newAgentWebhookTools.push(formTool);
                          logger.info(`   📋 Added submit_form tool for "${formInfo.formName}" nodeId: ${formInfo.nodeId || 'n/a'}`);
                        }
                      }

                      // Add messaging tools for send_email/send_whatsapp nodes in the flow
                      if (hasWebhookNodes && webhookNodes && webhookNodes.length > 0) {
                        const { buildMessagingEmailTool, buildMessagingWhatsappTool } = await import('../services/elevenlabs');
                        for (const webhookNode of webhookNodes) {
                          if (webhookNode.toolId.startsWith('send_email_') && !webhookNode.url) {
                            const templateName = webhookNode.payload?.template_name || 'default';
                            const emailTool = buildMessagingEmailTool(elevenLabsAgent.agent_id, [templateName], templateName);
                            emailTool.name = webhookNode.toolId;
                            newAgentWebhookTools.push(emailTool);
                            logger.info(`   📧 Added email messaging tool: ${webhookNode.toolId} -> template="${templateName}"`);
                          } else if (webhookNode.toolId.startsWith('send_whatsapp_') && !webhookNode.url) {
                            const templateName = webhookNode.payload?.template_name || 'hello_world';
                            const whatsappTool = buildMessagingWhatsappTool(elevenLabsAgent.agent_id, [templateName], templateName);
                            whatsappTool.name = webhookNode.toolId;
                            newAgentWebhookTools.push(whatsappTool);
                            logger.info(`   💬 Added WhatsApp messaging tool: ${webhookNode.toolId} -> template="${templateName}"`);
                          }
                        }
                      }

                      // Add custom webhook tools from flow builder (user-defined webhooks)
                      // Uses universal webhook builder to automatically include caller phone, conversation data, etc.
                      if (hasWebhookNodes && webhookNodes && webhookNodes.length > 0) {
                        logger.info(`🔗 [Flow Save] Adding universal webhook tools (${webhookNodes.length} webhooks) to agent ${elevenLabsAgent.agent_id}`);
                        const { buildUniversalWebhookTool } = await import('../services/universal-webhook-tool');
                        for (const webhookNode of webhookNodes) {
                          if (webhookNode.url) {
                            const webhookTool = buildUniversalWebhookTool({
                              toolId: webhookNode.toolId,
                              url: webhookNode.url,
                              method: webhookNode.method || 'POST',
                              headers: webhookNode.headers,
                              payload: webhookNode.payload
                            });
                            newAgentWebhookTools.push(webhookTool);
                            logger.info(`   🔗 Added universal webhook tool: ${webhookNode.toolId} -> ${webhookNode.method} [redacted]`);
                          }
                        }
                      }

                      // Add play audio tools if flow has play_audio nodes
                      if (hasPlayAudioNodes && playAudioNodes && playAudioNodes.length > 0) {
                        logger.info(`🔊 [Flow Save] Adding play audio tools (${playAudioNodes.length} nodes) to agent ${elevenLabsAgent.agent_id}`);
                        const { getPlayAudioWebhookTool } = await import('../services/play-audio-elevenlabs-tool');
                        for (const playAudioNode of playAudioNodes) {
                          const playAudioTool = getPlayAudioWebhookTool(
                            playAudioNode.nodeId,
                            playAudioNode.audioUrl,
                            playAudioNode.audioFileName,
                            playAudioNode.interruptible,
                            playAudioNode.waitForComplete,
                            elevenLabsAgent.agent_id
                          );
                          newAgentWebhookTools.push(playAudioTool);
                          logger.info(`   🔊 Added play audio tool: ${playAudioTool.name}`);
                        }
                      }

                      // Update agent with webhook tools if any
                      if (newAgentWebhookTools.length > 0) {
                        try {
                          await elevenlabsService.updateFlowAgentWorkflow(
                            elevenLabsAgent.agent_id,
                            compiledWorkflow,
                            agent.maxDurationSeconds || 900,
                            undefined, // detectLanguageEnabled
                            undefined, // language
                            undefined, // ttsModel
                            undefined, // llmModel
                            undefined, // temperature
                            undefined, // firstMessage
                            undefined, // voiceId
                            {
                              webhookTools: newAgentWebhookTools,
                              basePrompt: buildFlowAgentBasePrompt(agent.systemPrompt)
                            }
                          );
                          logger.info(`✅ [Flow Save] Webhook tools added (${newAgentWebhookTools.length} tools)`);
                        } catch (toolError: any) {
                          console.error(`❌ [Flow Save] Failed to add webhook tools:`, toolError.message);
                        }
                      }
                    } else {
                      logger.info(`   Updating existing ElevenLabs agent: ${agent.elevenLabsAgentId}`);

                      // Build webhook tools array
                      let webhookTools: any[] = [];

                      // Add RAG tool if agent has knowledge bases assigned
                      // This ensures KB tool is retained when flow is saved from flow editor
                      if (agent.knowledgeBaseIds && agent.knowledgeBaseIds.length > 0) {
                        const { isRAGEnabled, getAskKnowledgeWebhookTool } = await import('../services/rag-elevenlabs-tool');
                        if (isRAGEnabled()) {
                          const ragTool = getAskKnowledgeWebhookTool(agent.elevenLabsAgentId);
                          webhookTools.push(ragTool);
                          logger.info(`📚 [Flow Save] Including RAG knowledge tool in update`);
                        }
                      }

                      if (hasAppointmentNodes) {
                        const { getAppointmentToolForAgent } = await import('../services/appointment-elevenlabs-tool');
                        const appointmentTool = getAppointmentToolForAgent(agent.elevenLabsAgentId);
                        webhookTools.push(appointmentTool);
                        logger.info(`📅 [Flow Save] Including appointment booking tool in update`);
                      }

                      // Add form submission tools if flow has form nodes
                      if (hasFormNodes && formNodes && formNodes.length > 0) {
                        logger.info(`📋 [Flow Save] Including form submission tools (${formNodes.length} forms) in update`);
                        const { getSubmitFormWebhookTool } = await import('../services/form-elevenlabs-tool');
                        for (const formInfo of formNodes) {
                          const formTool = getSubmitFormWebhookTool(
                            formInfo.formId,
                            formInfo.formName,
                            formInfo.fields,
                            agent.elevenLabsAgentId,
                            formInfo.nodeId
                          );
                          webhookTools.push(formTool);
                          logger.info(`   📋 Added submit_form tool for "${formInfo.formName}" nodeId: ${formInfo.nodeId || 'n/a'}`);
                        }
                      }

                      // Add messaging tools for send_email/send_whatsapp nodes in the flow (update path)
                      if (hasWebhookNodes && webhookNodes && webhookNodes.length > 0) {
                        const { buildMessagingEmailTool, buildMessagingWhatsappTool } = await import('../services/elevenlabs');
                        for (const webhookNode of webhookNodes) {
                          if (webhookNode.toolId.startsWith('send_email_') && !webhookNode.url) {
                            const templateName = webhookNode.payload?.template_name || 'default';
                            const emailTool = buildMessagingEmailTool(agent.elevenLabsAgentId, [templateName], templateName);
                            emailTool.name = webhookNode.toolId;
                            webhookTools.push(emailTool);
                            logger.info(`   📧 Added email messaging tool: ${webhookNode.toolId} -> template="${templateName}"`);
                          } else if (webhookNode.toolId.startsWith('send_whatsapp_') && !webhookNode.url) {
                            const templateName = webhookNode.payload?.template_name || 'hello_world';
                            const whatsappTool = buildMessagingWhatsappTool(agent.elevenLabsAgentId, [templateName], templateName);
                            whatsappTool.name = webhookNode.toolId;
                            webhookTools.push(whatsappTool);
                            logger.info(`   💬 Added WhatsApp messaging tool: ${webhookNode.toolId} -> template="${templateName}"`);
                          }
                        }
                      }

                      // Add custom webhook tools from flow builder (user-defined webhooks)
                      // Uses universal webhook builder to automatically include caller phone, conversation data, etc.
                      if (hasWebhookNodes && webhookNodes && webhookNodes.length > 0) {
                        logger.info(`🔗 [Flow Save] Including universal webhook tools (${webhookNodes.length} webhooks) in update`);
                        const { buildUniversalWebhookTool } = await import('../services/universal-webhook-tool');
                        for (const webhookNode of webhookNodes) {
                          if (webhookNode.url) {
                            const webhookTool = buildUniversalWebhookTool({
                              toolId: webhookNode.toolId,
                              url: webhookNode.url,
                              method: webhookNode.method || 'POST',
                              headers: webhookNode.headers,
                              payload: webhookNode.payload
                            });
                            webhookTools.push(webhookTool);
                            logger.info(`   🔗 Added universal webhook tool: ${webhookNode.toolId} -> ${webhookNode.method} [redacted]`);
                          }
                        }
                      }

                      // Add play audio tools if flow has play_audio nodes
                      if (hasPlayAudioNodes && playAudioNodes && playAudioNodes.length > 0) {
                        logger.info(`🔊 [Flow Save] Including play audio tools (${playAudioNodes.length} nodes) in update`);
                        const { getPlayAudioWebhookTool } = await import('../services/play-audio-elevenlabs-tool');
                        for (const playAudioNode of playAudioNodes) {
                          const playAudioTool = getPlayAudioWebhookTool(
                            playAudioNode.nodeId,
                            playAudioNode.audioUrl,
                            playAudioNode.audioFileName,
                            playAudioNode.interruptible,
                            playAudioNode.waitForComplete,
                            agent.elevenLabsAgentId
                          );
                          webhookTools.push(playAudioTool);
                          logger.info(`   🔊 Added play audio tool: ${playAudioTool.name}`);
                        }
                      }

                      await elevenlabsService.updateFlowAgentWorkflow(
                        agent.elevenLabsAgentId,
                        compiledWorkflow,
                        agent.maxDurationSeconds || 900,
                        agent.detectLanguageEnabled || false,
                        agent.language || undefined,
                        undefined, // ttsModel
                        undefined, // llmModel
                        undefined, // temperature
                        flowFirstMessage,
                        undefined, // voiceId
                        {
                          webhookTools: webhookTools.length > 0 ? webhookTools : undefined,
                          basePrompt: buildFlowAgentBasePrompt(agent.systemPrompt)
                        }
                      );

                      logger.info(`✅ [Flow Save] Updated ElevenLabs agent workflow`);
                      if (webhookTools.length > 0) {
                        logger.info(`   📦 Included ${webhookTools.length} webhook tools`);
                      }
                    }
                  } else {
                    logger.warn(`⚠️ [Flow Save] Flow has no nodes, skipping ElevenLabs sync`);
                  }
                }
              }
            }
          }
        } catch (syncError: any) {
          console.error(`❌ [Flow Save] ElevenLabs sync error:`, syncError.message);
        }
      }

      res.json(updatedFlow);
    } catch (error: any) {
      console.error("Error updating flow:", error);
      res.status(500).json({ error: "Failed to update flow" });
    }
  });

  router.delete("/flows/:id", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;

      // Verify the flow belongs to this user and company before touching related records
      const [existingFlow] = await db
        .select({ id: flows.id })
        .from(flows)
        .where(and(eq(flows.id, id), eq(flows.userId, userId), eq(flows.companyId, companyId)))
        .limit(1);

      if (!existingFlow) {
        return res.status(404).json({ error: "Flow not found" });
      }

      // Remove FK-constrained child records before deleting the flow row.
      // flowExecutions.flowId: NOT NULL + NO ACTION → must be hard-deleted first.
      // flowTestQueue.flowId: NOT NULL + CASCADE → handled by DB, but deleted
      //   explicitly here for clarity.
      // appointments.flowId + agents.flowId: nullable + NO ACTION → nullified.
      await db.delete(flowTestQueue).where(eq(flowTestQueue.flowId, id));
      await db.delete(flowExecutions).where(eq(flowExecutions.flowId, id));
      await db.update(appointments).set({ flowId: null }).where(eq(appointments.flowId, id));
      await db.update(agents).set({ flowId: null }).where(eq(agents.flowId, id));

      await db.delete(flows).where(eq(flows.id, id));

      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting flow:", error);
      res.status(500).json({ error: "This flow cannot be deleted — please try again or contact support." });
    }
  });

  // Admin endpoint to resync a flow agent's first message to ElevenLabs
  // This is useful when the ElevenLabs agent's first_message doesn't match the flow's compiled message
  router.post("/flows/:id/resync-first-message", async (req: AuthRequest, res: Response) => {
    try {
      if (!req.userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userId = req.userId!;
      const companyId = companyForRead(req, res);
      if (!companyId) return;
      const { id } = req.params;

      const [flow] = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, id), eq(flows.userId, userId), eq(flows.companyId, companyId)))
        .limit(1);

      if (!flow) {
        return res.status(404).json({ error: "Flow not found" });
      }

      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, flow.agentId as string), eq(agents.companyId, companyId)))
        .limit(1);

      if (!agent?.elevenLabsAgentId) {
        return res.status(400).json({ error: "Agent not synced with ElevenLabs" });
      }

      // Get the correct first message from flow nodes (entry node message)
      const flowNodes = (flow.nodes || []) as any[];
      let firstMessageFromFlow = flow.compiledFirstMessage as string | null;

      // If no compiled first message, extract from entry node
      if (!firstMessageFromFlow && flowNodes.length > 0) {
        const entryNode = flowNodes.find((n: any) => n.type === 'message' && n.data?.isEntry);
        if (entryNode?.data?.config?.message) {
          firstMessageFromFlow = entryNode.data.config.message;
        } else {
          // Try first node as entry
          const firstNode = flowNodes[0];
          if (firstNode?.data?.config?.message) {
            firstMessageFromFlow = firstNode.data.config.message;
          }
        }
      }

      if (!firstMessageFromFlow) {
        return res.status(400).json({ error: "No first message found in flow" });
      }

      logger.info(`📝 [Resync] Updating ElevenLabs agent ${agent.elevenLabsAgentId} first_message`);
      logger.info(`   Current flow compiled_first_message: "${firstMessageFromFlow}"`);

      // Get ElevenLabs credential and update agent
      const credential = await ElevenLabsPoolService.getCredentialForAgent(agent.id);
      if (!credential) {
        return res.status(400).json({ error: "No ElevenLabs credential found for agent" });
      }

      const elevenlabsService = new ElevenLabsService(credential.apiKey);
      await elevenlabsService.updateAgent(agent.elevenLabsAgentId, {
        first_message: firstMessageFromFlow,
      });

      logger.info(`✅ [Resync] Successfully updated ElevenLabs agent first_message`);

      res.json({
        success: true,
        message: "First message resynced to ElevenLabs",
        firstMessage: firstMessageFromFlow
      });
    } catch (error: any) {
      console.error("Error resyncing first message:", error);
      res.status(500).json({ error: "Failed to resync first message" });
    }
  });
}
