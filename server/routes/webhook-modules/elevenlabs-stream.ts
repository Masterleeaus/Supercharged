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
import { db } from '../../db';
import { calls, agents, knowledgeBase } from '../../../shared/schema';
import { eq, and, or, inArray } from 'drizzle-orm';
import WebSocket from 'ws';
import { ElevenLabsService } from '../../services/elevenlabs';
import { ElevenLabsPoolService } from '../../services/elevenlabs-pool';
import { logger } from '../../utils/logger';
import { storage } from '../../storage';
import { sendWebSocketWithRetry, formatAndSaveTranscript } from '../webhooks/helpers';
import { executeCallTransfer } from './twilio-call-helpers';

// Helper function to setup ElevenLabs message handlers
export function setupElevenLabsMessageHandlers(
  elevenLabsWs: WebSocket,
  callId: string,
  streamSid: string | null,
  twilioWs: WebSocket,
  conversationHistory: Array<{ role: 'user' | 'agent', text: string, timestamp: Date }>,
  silenceTimerRef: { current: NodeJS.Timeout | null },
  endCall: (reason: string) => Promise<void>,
  flowBridge?: any  // Optional FlowExecutionBridge instance
): void {
  // Start initial silence timer when connection is established
  if (silenceTimerRef.current) {
    clearTimeout(silenceTimerRef.current);
  }
  silenceTimerRef.current = setTimeout(async () => {
    logger.info(`🔇 [Silence Detected] No activity/speech at the start of the call for 30 seconds, ending call...`);
    await endCall('30 seconds of initial silence detected');
  }, 30000);

  elevenLabsWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      logger.info(`📨 [ElevenLabs] Received message type: ${message.type}`);

      switch (message.type) {
        case 'conversation_initiation_metadata':
          logger.info(`✅ [ElevenLabs] Conversation initiated for call ${callId}`);
          break;

        case 'audio':
          let audioPayload: string | null = null;

          if (message.audio?.chunk) {
            audioPayload = message.audio.chunk;
          } else if (message.audio_event?.audio_base_64) {
            audioPayload = message.audio_event.audio_base_64;
          }

          // Reset silence timer on audio chunk to prevent timeout while agent is speaking
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }
          silenceTimerRef.current = setTimeout(async () => {
            logger.info(`🔇 [Silence Detected] No activity for 30 seconds after agent audio, ending call...`);
            await endCall('30 seconds of silence detected');
          }, 30000);

          if (audioPayload && streamSid) {
            const audioData = {
              event: 'media',
              streamSid,
              media: {
                payload: audioPayload,
              },
            };
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify(audioData));
            }
          }
          break;

        case 'interruption':
          logger.info(`🛑 [ElevenLabs] User interruption detected`);
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
          }
          break;

        case 'user_transcript':
          const userText = message.user_transcription_event?.user_transcript || 'N/A';
          const userTranscriptLength = userText.length;
          const transcriptTime = new Date().toISOString();

          // Enhanced logging for transcription quality monitoring
          logger.info(`🗣️ [User Said]: "${userText}"`);
          logger.info(`   📊 Transcript length: ${userTranscriptLength} chars`);
          logger.info(`   ⏱️  Received at: ${transcriptTime}`);
          if (message.user_transcription_event?.confidence) {
            logger.info(`   🎯 Confidence: ${message.user_transcription_event.confidence}`);
          }

          if (userText && userText !== 'N/A') {
            conversationHistory.push({
              role: 'user',
              text: userText,
              timestamp: new Date()
            });

            // Real-time banned word detection
            try {
              const callRecord = await storage.getCall(callId);
              if (callRecord && callRecord.userId) {
                const bannedWords = await storage.getActiveBannedWords();
                const userTextLower = userText.toLowerCase();

                let violationDetected = false;
                let autoBlockTriggered = false;

                for (const bannedWord of bannedWords) {
                  const wordLower = bannedWord.word.toLowerCase();
                  if (userTextLower.includes(wordLower)) {
                    logger.info(`🚨 [Realtime Banned Word] Detected "${bannedWord.word}" in user transcript for call ${callId}`);

                    // Calculate context
                    const position = userTextLower.indexOf(wordLower);
                    const contextStart = Math.max(0, position - 50);
                    const contextEnd = Math.min(userText.length, position + wordLower.length + 50);
                    const context = userText.substring(contextStart, contextEnd);

                    // Create Content Violation
                    await storage.createContentViolation({
                      callId,
                      userId: callRecord.userId,
                      bannedWordId: bannedWord.id,
                      detectedWord: bannedWord.word,
                      severity: bannedWord.severity,
                      context: context,
                      status: 'pending',
                    });

                    violationDetected = true;

                    // Handle Auto-Block
                    if (bannedWord.autoBlock) {
                      autoBlockTriggered = true;
                      const user = await storage.getUser(callRecord.userId);
                      if (user && user.role !== 'admin' && user.isActive) {
                        await storage.updateUser(callRecord.userId, {
                          isActive: false,
                          blockedReason: `Auto-blocked: Realtime content violation detected (${bannedWord.category}: "${bannedWord.word}")`,
                          blockedAt: new Date(),
                          blockedBy: 'system',
                        });
                        logger.info(`⚠️ [Realtime Banned Word] Auto-blocked user ${callRecord.userId} for violation: ${bannedWord.word}`);
                      }

                      // End the call immediately if autoBlock is enabled
                      logger.info(`🚫 [Realtime Banned Word] Auto-block is ON. Terminating call ${callId}`);
                      await endCall('Banned word detected (auto-block)');
                      break; // Stop checking more words
                    }
                  }
                }

                if (autoBlockTriggered) {
                  return; // Stop processing the transcript event
                }

                if (violationDetected) {
                  // If autoBlock is OFF but violation was detected, give a warning to the customer
                  logger.warn(`⚠️ [Realtime Banned Word] Violation detected but Auto-block is OFF. Giving warning to customer for call ${callId}`);

                  // Send warning instruction to ElevenLabs
                  const warningText = `[SYSTEM WARNING] The user used inappropriate or offensive language. Please politely warn the user to refrain from using offensive language and continue the conversation.`;
                  await sendWebSocketWithRetry(elevenLabsWs, {
                    type: "contextual_update",
                    text: warningText
                  });
                }
              }
            } catch (violationError) {
              logger.error(`❌ [Realtime Banned Word] Error checking violations:`, violationError);
            }

            // Process user response through flow bridge if in flow mode
            if (flowBridge) {
              try {
                // Process response - this auto-progresses through nodes
                await flowBridge.processUserResponse(userText);
                logger.info(`[Flow Bridge] ✅ Processed user response`);

                // Check if flow has ended (after auto-progression)
                if (flowBridge.hasFlowEnded()) {
                  logger.info(`[Flow Bridge] 🎯 Flow execution completed (reached END node)`);

                  // Send final contextual update with END node message
                  try {
                    const finalUpdate = flowBridge.generateContextualUpdate();
                    const finalText = finalUpdate.text || "Thank you for your time. Goodbye!";

                    logger.info(`[Flow Bridge] 📤 Sending final contextual update to ElevenLabs:`);
                    logger.info(`   Instruction: "${finalText}"`);

                    const success = await sendWebSocketWithRetry(elevenLabsWs, {
                      type: "contextual_update",
                      text: finalText
                    });

                    if (success) {
                      logger.info(`[Flow Bridge] ✅ Final contextual update sent`);
                    } else {
                      logger.error(`[Flow Bridge] ❌ Failed to send final update after retries - terminating call anyway`);
                    }
                  } catch (sendError) {
                    logger.error(`[Flow Bridge] ❌ Failed to send final contextual update:`, sendError);
                  }

                  // Don't update call status here - let it be updated when call actually ends
                  // The Twilio status webhook will update status to 'completed' when call terminates
                  // This ensures DB state matches actual call lifecycle
                  logger.info(`[Flow Bridge] ✅ Flow execution completed - final goodbye sent`);
                  logger.info(`[Flow Bridge] 📞 Letting call end naturally via silence detection`);
                  logger.info(`[Flow Bridge] 💾 Call status will be updated to 'completed' by Twilio webhook when call actually ends`);
                } else {
                  // Send contextual update to ElevenLabs with next node instructions
                  if (flowBridge.shouldSendContextualUpdate()) {
                    try {
                      const contextualUpdate = flowBridge.generateContextualUpdate();
                      const instructionText = contextualUpdate.text || "Continue the conversation.";

                      if (instructionText.trim()) {
                        logger.info(`[Flow Bridge] 📤 Sending contextual update to ElevenLabs:`);
                        logger.info(`   Instruction: "${instructionText}"`);

                        const success = await sendWebSocketWithRetry(elevenLabsWs, {
                          type: "contextual_update",
                          text: instructionText
                        });

                        if (success) {
                          logger.info(`[Flow Bridge] ✅ Contextual update sent`);
                        } else {
                          logger.error(`[Flow Bridge] ❌ Failed to send contextual update after retries`);
                        }
                      } else {
                        logger.warn(`[Flow Bridge] ℹ️ Skipping empty contextual update (likely condition node)`);
                      }
                    } catch (sendError) {
                      logger.error(`[Flow Bridge] ❌ Failed to send contextual update:`, sendError);
                    }
                  } else {
                    logger.info(`[Flow Bridge] ℹ️ No contextual update needed for current node`);
                  }
                }
              } catch (error) {
                logger.error(`[Flow Bridge] ❌ Error processing user response:`, error);
                logger.error(error);
                // Don't fail the entire call - log error and continue without flow
              }
            }

            // Check for user rejection/disinterest phrases
            const rejectionPhrases = [
              'not interested', 'no thanks', 'stop calling',
              'remove my number', 'don\'t call', 'bye',
              'goodbye', 'hang up', 'disconnect',
              'interested nahi', 'nahi chahiye', 'band karo',
              'rukiye', 'call mat karo', 'बाद में'
            ];

            const lowerUserText = userText.toLowerCase();
            const userRejected = rejectionPhrases.some(phrase => lowerUserText.includes(phrase));

            if (userRejected) {
              logger.warn(`🚫 [User Rejected] User expressed disinterest, ending call in 2 seconds...`);
              setTimeout(async () => {
                await endCall('User expressed disinterest');
              }, 2000);
            }
          }

          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }

          silenceTimerRef.current = setTimeout(async () => {
            logger.info(`🔇 [Silence Detected] No user speech for 30 seconds, ending call...`);
            await endCall('30 seconds of user silence detected');
          }, 30000);
          break;

        case 'agent_response':
          const agentText = message.agent_response_event?.agent_response || 'N/A';
          logger.info(`🤖 [AI Responded]: "${agentText}"`);

          if (agentText && agentText !== 'N/A') {
            conversationHistory.push({
              role: 'agent',
              text: agentText,
              timestamp: new Date()
            });
          }

          // Reset silence timer when agent responds (restart 30s countdown from agent's last message)
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }

          silenceTimerRef.current = setTimeout(async () => {
            logger.info(`🔇 [Silence Detected] No activity for 30 seconds after agent response, ending call...`);
            await endCall('30 seconds of silence detected');
          }, 30000);

          const goodbyePhrases = [
            'goodbye', 'bye bye', 'thank you for calling',
            'have a nice day', 'have a wonderful day', 'thank you for choosing',
            'take care', 'alvida', 'dhanyawad', 'shukriya', 'aapka din shubh ho'
          ];

          const lowerText = agentText.toLowerCase();
          const saidGoodbye = goodbyePhrases.some(phrase => lowerText.includes(phrase));

          if (saidGoodbye && !lowerText.includes('?')) {
            logger.warn(`👋 [Agent Farewell] Agent said goodbye - setting short 5-second silence timeout to end call`);
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
            }
            silenceTimerRef.current = setTimeout(async () => {
              logger.info(`👋 [Agent Farewell] Ending call 5 seconds after agent said goodbye`);
              await endCall('Agent said goodbye');
            }, 5000);
          }
          break;

        case 'ping':
          if (message.ping_event?.event_id && elevenLabsWs) {
            const pongResponse = {
              type: 'pong',
              event_id: message.ping_event.event_id,
            };
            elevenLabsWs.send(JSON.stringify(pongResponse));
          }
          break;

        case 'client_tool_call':
          logger.info(`🔧 [Client Tool] Tool call received:`, message.client_tool_call);
          const toolCall = message.client_tool_call;

          if (toolCall?.tool_name === 'transfer_call') {
            logger.info(`📞 [Call Transfer] Agent requested call transfer`);
            logger.info(`   Reason: ${toolCall.parameters?.reason || 'Not specified'}`);
            logger.info(`   Tool Call ID: ${toolCall.tool_call_id}`);

            try {
              // Get call details (works for both incoming and campaign calls)
              const call = await storage.getCallWithDetails(callId);
              if (!call) {
                throw new Error('Call not found');
              }

              // Determine agent ID from either incoming connection or campaign
              let agentIdToUse: string;

              if (call.incomingConnection?.agentId) {
                // Incoming call - get agent from incoming connection
                agentIdToUse = call.incomingConnection.agentId;
                logger.info(`   📞 Incoming call - using incoming agent: ${agentIdToUse}`);
              } else if (call.campaign?.agentId) {
                // Outgoing campaign call - get agent from campaign
                agentIdToUse = call.campaign.agentId;
                logger.info(`   📞 Campaign call - using campaign agent: ${agentIdToUse}`);
              } else {
                throw new Error('Call is not associated with any agent (neither incoming nor campaign)');
              }

              // Get agent details to retrieve transfer phone number
              const agent = await storage.getAgent(agentIdToUse);
              if (!agent?.transferPhoneNumber) {
                throw new Error('Transfer phone number not configured for this agent');
              }

              const transferNumber = agent.transferPhoneNumber;
              logger.info(`   📲 Transferring to: [redacted]`);

              // Execute the transfer via Twilio REST API
              if (!call.twilioSid) {
                throw new Error('Twilio CallSid not available for transfer');
              }

              await executeCallTransfer(call.twilioSid, transferNumber);

              // Send success result back to ElevenLabs
              const successResult = {
                type: 'client_tool_result',
                tool_call_id: toolCall.tool_call_id,
                result: `Successfully transferred call to ${transferNumber}`,
                is_error: false
              };

              elevenLabsWs.send(JSON.stringify(successResult));
              logger.info(`✅ [Call Transfer] Transfer initiated and confirmed to ElevenLabs`);

              // Update call metadata for CRM Lead Processor detection
              try {
                const existingMetadata = (call.metadata as Record<string, unknown>) || {};
                const existingAiInsights = (existingMetadata.aiInsights as Record<string, unknown>) || {};

                const updatedMetadata = {
                  ...existingMetadata,
                  wasTransferred: true,
                  hasTransfer: true,
                  transferredTo: transferNumber,
                  transferredAt: new Date().toISOString(),
                  aiInsights: {
                    ...existingAiInsights,
                    primaryOutcome: 'call_transfer',
                    wasTransferred: true,
                    transferTarget: transferNumber,
                  },
                };

                await db
                  .update(calls)
                  .set({
                    wasTransferred: true,
                    transferredTo: transferNumber,
                    metadata: updatedMetadata
                  })
                  .where(eq(calls.id, callId));

                logger.info(`📞 [Call Transfer] Updated call metadata for CRM detection`);
              } catch (metadataError: any) {
                logger.error(`📞 [Call Transfer] Failed to update call metadata:`, metadataError.message);
              }

            } catch (error: any) {
              logger.error(`❌ [Call Transfer] Failed:`, error);

              // Determine detailed error message for ElevenLabs
              let errorMessage = 'We encountered a technical difficulty while transferring your call';
              if (error.message?.includes('not found')) {
                errorMessage = 'Call not found or ended';
              } else if (error.message?.includes('not configured')) {
                errorMessage = 'Transfer phone number not configured for this agent';
              } else if (error.message?.includes('not associated')) {
                errorMessage = 'Call not associated with an incoming agent';
              } else if (error.message?.includes('Twilio')) {
                errorMessage = 'A technical difficulty occurred during the transfer';
              }

              // Send error result back to ElevenLabs with user-friendly message
              const errorResult = {
                type: 'client_tool_result',
                tool_call_id: toolCall.tool_call_id,
                result: `I apologize, but I was unable to transfer your call. ${errorMessage}. Please try calling back or contact support directly.`,
                is_error: true
              };

              elevenLabsWs.send(JSON.stringify(errorResult));
              logger.error(`❌ [Call Transfer] Error sent to ElevenLabs: ${errorMessage}`);
            }
          } else {
            logger.info(`❓ [Client Tool] Unknown tool: ${toolCall?.tool_name}`);
          }
          break;

        default:
          logger.info(`❓ [ElevenLabs] Unhandled message type: ${message.type}`);
      }
    } catch (error) {
      logger.error(`❌ [ElevenLabs] Error parsing message for call ${callId}:`, error);
    }
  });
}

// Helper function to initialize ElevenLabs connection
export async function initializeElevenLabsConnection(
  agentId: string,
  callId: string,
  contactName: string | undefined,
  contactPhone: string | undefined,
  streamSid: string | null,
  twilioWs: WebSocket,
  conversationHistory: Array<{ role: 'user' | 'agent', text: string, timestamp: Date }>,
  silenceTimerRef: { current: NodeJS.Timeout | null },
  endCall: (reason: string) => Promise<void>,
  flowBridge?: any  // Optional FlowExecutionBridge instance
): Promise<WebSocket> {
  // agentId is the database UUID - need to look up the ElevenLabs agent ID
  logger.info(`[Stream] Looking up ElevenLabs agent ID for database agent ${agentId}`);

  const agent = await storage.getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  if (!agent.elevenLabsAgentId) {
    throw new Error(`Agent ${agentId} is missing ElevenLabs configuration. Please configure the agent in the admin panel.`);
  }

  const elevenLabsAgentId = agent.elevenLabsAgentId;
  logger.info(`[Stream] Resolved database agent ${agentId} to ElevenLabs agent ${elevenLabsAgentId}`);

  // Get the pool-assigned credential for this agent
  logger.info(`[Stream] 🔑 Resolving pool-assigned credential for agent ${agentId}...`);
  const credential = await ElevenLabsPoolService.getCredentialForAgent(agentId);
  if (!credential) {
    throw new Error(`No ElevenLabs credential found for agent ${agentId}`);
  }
  logger.info(`[Stream] ✅ Using credential: ${credential.name} (ID: ${credential.id})`);

  // Create ElevenLabsService instance with the agent's pool-assigned credential
  const agentElevenLabsService = new ElevenLabsService(credential.apiKey);

  // Sync agent configuration to ElevenLabs before starting call
  // SKIP for Flow agents - their workflow is already compiled and saved when user edits the flow
  // Syncing here would overwrite the visual flow with a simplified built-in tools workflow
  if (agent.type === 'flow') {
    logger.warn(`[Stream] ⏭️ Skipping agent sync for Flow agent - workflow is managed by flow builder`);
  } else {
    // For Natural/Incoming agents, sync configuration to ensure latest settings
    logger.info(`[Stream] 🔄 Syncing agent configuration to ElevenLabs...`);
    try {
      // Fetch knowledge base items if agent has knowledge base IDs
      let knowledgeBases: any[] = [];
      if (agent.knowledgeBaseIds && agent.knowledgeBaseIds.length > 0) {
        logger.info(`[Stream] 📚 Fetching ${agent.knowledgeBaseIds.length} knowledge base items...`);
        const kbItems = await db
          .select()
          .from(knowledgeBase)
          .where(inArray(knowledgeBase.id, agent.knowledgeBaseIds));

        knowledgeBases = kbItems
          .filter(kb => kb.elevenLabsDocId) // Only include items synced to ElevenLabs
          .map(kb => ({
            type: kb.type,
            title: kb.title,
            elevenLabsDocId: kb.elevenLabsDocId,
          }));

        logger.info(`[Stream] 📚 Found ${knowledgeBases.length} synced knowledge base items`);
      }

      await agentElevenLabsService.updateAgent(elevenLabsAgentId, {
        prompt: agent.systemPrompt || undefined,
        voice_tone: agent.voiceTone || undefined,
        personality: agent.personality || undefined,
        first_message: agent.firstMessage || undefined,
        model: agent.llmModel || undefined,
        temperature: agent.temperature || undefined,
        language: agent.language || undefined,
        knowledge_bases: knowledgeBases.length > 0 ? knowledgeBases : undefined,
        // Include tool settings to preserve them during call initialization
        transferEnabled: agent.transferEnabled || undefined,
        transferPhoneNumber: agent.transferPhoneNumber || undefined,
        detectLanguageEnabled: agent.detectLanguageEnabled || undefined,
        endConversationEnabled: agent.endConversationEnabled || undefined,
      });
      logger.info(`[Stream] ✅ Agent configuration synced to ElevenLabs using credential: ${credential.name}`);
    } catch (syncError: any) {
      logger.error(`[Stream] ⚠️ Failed to sync agent config (continuing anyway):`, syncError.message);
      // Continue with call even if sync fails - agent will use previous config
    }
  }

  // Check if this is a Flow agent (uses native ElevenLabs workflows)
  const isFlowAgent = agent.type === 'flow';

  logger.info(`[Stream] Getting fresh signed URL for ElevenLabs agent ${elevenLabsAgentId} using credential: ${credential.name}`);
  const wsAuth = await agentElevenLabsService.getConversationWebSocketAuth(elevenLabsAgentId);

  if (!wsAuth.signed_url) {
    throw new Error('Failed to get signed URL from ElevenLabs');
  }

  logger.info(`[ElevenLabs] Attempting to connect to ElevenLabs WebSocket...`);
  logger.info(`[ElevenLabs] Signed URL obtained (first 100 chars): [redacted]...`);
  const elevenLabsWs = new WebSocket(wsAuth.signed_url);

  elevenLabsWs.on('open', async () => {
    logger.info(`✅ [ElevenLabs] WebSocket connection established for call ${callId}`);

    // Increment load counter for this credential
    try {
      await ElevenLabsPoolService.incrementLoad(credential.id);
      logger.info(`[Pool] ✅ Incremented load for credential: ${credential.name}`);
    } catch (loadError) {
      logger.error(`[Pool] ⚠️ Failed to increment load:`, loadError);
      // Continue with call even if load tracking fails
    }

    // For Flow agents with native ElevenLabs workflows:
    // DO NOT send any agent config - let ElevenLabs use the saved workflow without overrides
    // Sending an empty agent: {} could override/disable the workflow
    if (isFlowAgent) {
      logger.info(`[ElevenLabs] 🔄 Flow Agent: Using native ElevenLabs workflow (no config override)`);

      // Only send dynamic variables if we have them, no agent config
      const hasDynamicVars = !!(contactName || contactPhone);

      if (hasDynamicVars) {
        const minimalConfig = {
          type: "conversation_initiation_client_data",
          conversation_config: {
            dynamic_variables: {
              ...(contactName && { contact_name: contactName }),
              ...(contactPhone && { contact_phone: contactPhone }),
            }
          }
        };
        logger.info(`[ElevenLabs] Sending minimal config (dynamic vars only)`);
        logger.info(`   Dynamic variables:`, JSON.stringify(minimalConfig.conversation_config.dynamic_variables));
        elevenLabsWs.send(JSON.stringify(minimalConfig));
      } else {
        // For Flow agents with no dynamic vars, don't send any initiation config
        // Let ElevenLabs use the agent's saved workflow configuration entirely
        logger.info(`[ElevenLabs] No initiation config sent - using agent's saved workflow`);
      }

      logger.info(`[ElevenLabs] ✅ Flow agent ready - workflow handles conversation flow`);
    } else {
      // For Natural/Incoming agents, use the standard conversation config
      const conversationConfig: any = {
        agent: {},
        dynamic_variables: {}
      };

      // Add dynamic variables
      if (contactName) {
        conversationConfig.dynamic_variables.contact_name = contactName;
        logger.info(`[ElevenLabs] Adding contact name: ${contactName}`);
      }
      if (contactPhone) {
        conversationConfig.dynamic_variables.contact_phone = contactPhone;
        logger.info(`[ElevenLabs] Adding contact phone: [redacted]`);
      }

      // For flow-based calls with flowBridge (legacy), use first_message from the flow
      if (flowBridge) {
        const firstMessage = flowBridge.getFirstMessage();
        logger.info(`[ElevenLabs] 🔀 Flow Mode: Setting first message from flow`);
        logger.info(`   First message: "${firstMessage}"`);
        conversationConfig.agent.first_message = firstMessage;
      }

      // Build the complete initiation message with correct structure
      const initialConfig = {
        type: "conversation_initiation_client_data",
        conversation_config: conversationConfig
      };

      logger.info(`[ElevenLabs] Sending conversation initiation`);
      logger.info(`   Dynamic variables:`, JSON.stringify(conversationConfig.dynamic_variables));

      elevenLabsWs.send(JSON.stringify(initialConfig));
      logger.info(`[ElevenLabs] ✅ Sent initial config`);
    }

    // Continue with flow bridge handling only for non-Flow agents
    if (!isFlowAgent && elevenLabsWs) {

      // For flow-based calls, ALWAYS send contextual update after auto-progression
      // (initialize() may have advanced through message/delay/condition nodes)
      if (flowBridge) {
        // Small delay to ensure initial config is processed first
        setTimeout(async () => {
          try {
            // Generate contextual update regardless of node type
            // This ensures agent gets instructions even if flow auto-progressed
            const contextualUpdate = flowBridge.generateContextualUpdate();
            const instructionText = contextualUpdate.text || "";

            // Always send if we have non-empty text OR if we're on an END node
            if (instructionText.trim() || flowBridge.hasFlowEnded()) {
              logger.info(`[Flow Bridge] 📤 Sending post-initialization contextual update:`);
              logger.info(`   Instruction: "${instructionText}"`);
              logger.info(`   Flow ended: ${flowBridge.hasFlowEnded()}`);

              const success = await sendWebSocketWithRetry(elevenLabsWs, {
                type: "contextual_update",
                text: instructionText || "Continue the conversation."
              });

              if (success) {
                logger.info(`[Flow Bridge] ✅ Post-init contextual update sent`);
              } else {
                logger.error(`[Flow Bridge] ❌ Failed to send post-init update after retries`);
              }
            } else {
              // If text is empty and not END node, send a generic instruction
              logger.info(`[Flow Bridge] ℹ️ Sending fallback instruction after auto-progression`);
              const success = await sendWebSocketWithRetry(elevenLabsWs, {
                type: "contextual_update",
                text: "Continue the conversation naturally."
              });

              if (success) {
                logger.info(`[Flow Bridge] ✅ Fallback instruction sent`);
              } else {
                logger.error(`[Flow Bridge] ❌ Failed to send fallback instruction after retries`);
              }
            }
          } catch (error) {
            logger.error(`[Flow Bridge] ❌ Failed to send post-init contextual update:`, error);
          }
        }, 100);
      }
    }
  });

  setupElevenLabsMessageHandlers(
    elevenLabsWs,
    callId,
    streamSid,
    twilioWs,
    conversationHistory,
    silenceTimerRef,
    endCall,
    flowBridge  // Pass flow bridge to message handlers
  );

  elevenLabsWs.on('error', (error) => {
    logger.error(`[ElevenLabs] WebSocket error for call ${callId}:`, error);
  });

  elevenLabsWs.on('close', async (code, reason) => {
    logger.info(`[ElevenLabs] WebSocket closed for call ${callId}`);
    logger.info(`   Close code: ${code}`);
    logger.info(`   Close reason: ${reason.toString() || 'No reason provided'}`);

    // Decrement load counter for this credential
    try {
      await ElevenLabsPoolService.decrementLoad(credential.id);
      logger.info(`[Pool] ✅ Decremented load for credential: ${credential.name}`);
    } catch (loadError) {
      logger.error(`[Pool] ⚠️ Failed to decrement load:`, loadError);
    }

    await formatAndSaveTranscript(callId, conversationHistory);

    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }

    // Hang up Twilio call when ElevenLabs connection closes (e.g. via end_call tool or graceful close)
    await endCall('ElevenLabs connection closed');
  });

  return elevenLabsWs;
}
