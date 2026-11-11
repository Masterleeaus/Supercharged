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
import { logger } from '../utils/logger';
import type { ElevenLabsWorkflow } from './enhanced-flow-compiler';
/**
 * Outbound Call Service
 * 
 * Handles outbound calls via ElevenLabs Twilio integration.
 * This is separate from the main ElevenLabs service to keep incoming and outgoing call logic isolated.
 * 
 * API Endpoint: POST /v1/convai/twilio/outbound-call
 * @see https://elevenlabs.io/docs/api-reference/twilio/outbound-call
 */

export interface OutboundCallParams {
  agentId: string;
  agentPhoneNumberId: string;
  toNumber: string;
  firstMessage?: string;
  dynamicData?: Record<string, string>;
  workflow?: ElevenLabsWorkflow;
  webhookTools?: any[];
  conversationInitiationClientData?: {
    conversationConfigOverride?: {
      agent?: {
        prompt?: {
          prompt?: string;
        };
        first_message?: string;
        conversation_config?: any;
      };
      workflow?: ElevenLabsWorkflow;
    };
    webhook_tools?: any[];
    dynamic_variables?: Record<string, string>;
  };
}

export interface OutboundCallResponse {
  success: boolean;
  message: string;
  conversationId: string | null;
  callSid: string | null;
}

export class OutboundCallService {
  private apiKey: string;
  private baseUrl: string = 'https://api.elevenlabs.io/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Initiate an outbound call via ElevenLabs Twilio integration
   * POST /v1/convai/twilio/outbound-call
   * 
   * @param params - Outbound call parameters (camelCase as per ElevenLabs SDK)
   * @returns Call response with conversation ID and call SID
   */
  async initiateCall(params: OutboundCallParams): Promise<OutboundCallResponse> {
    logger.info(`📞 [OutboundCallService] Initiating outbound call`);
    logger.info(`   Agent ID: ${params.agentId}`);
    logger.info(`   Phone Number ID: ${params.agentPhoneNumberId}`);
    logger.info(`   To: ${params.toNumber}`);

    // Build request body with snake_case keys as per ElevenLabs REST API
    // Note: The SDK uses camelCase but converts to snake_case internally
    const requestBody: Record<string, any> = {
      agent_id: params.agentId,
      agent_phone_number_id: params.agentPhoneNumberId,
      to_number: params.toNumber,
    };

    // Add optional conversation config override and workflow
    if (params.workflow || params.conversationInitiationClientData?.conversationConfigOverride) {
      if (!requestBody.conversation_initiation_client_data) {
        requestBody.conversation_initiation_client_data = {};
      }

      const configOverride = params.conversationInitiationClientData?.conversationConfigOverride || {};
      if (params.workflow) {
        configOverride.workflow = params.workflow;
      }

      requestBody.conversation_initiation_client_data.conversation_config_override = configOverride;

      // Set global interruption sensitivity to 0 to protect the greeting and first tool call
      if (!configOverride.agent) configOverride.agent = {};
      if (!configOverride.agent.conversation_config) configOverride.agent.conversation_config = {};
      if (!configOverride.agent.conversation_config.turn_taking) {
        configOverride.agent.conversation_config.turn_taking = {};
      }
      configOverride.agent.conversation_config.turn_taking.interruption_sensitivity = 0;

      // Use the native first_message field if provided by the compiler
      if (params.firstMessage) {
        if (!configOverride.agent) configOverride.agent = {};
        configOverride.agent.first_message = params.firstMessage;
      }
    }

    // Add webhook tools override
    if (params.webhookTools && params.webhookTools.length > 0) {
      if (!requestBody.conversation_initiation_client_data) {
        requestBody.conversation_initiation_client_data = {};
      }
      requestBody.conversation_initiation_client_data.webhook_tools = params.webhookTools;
    }

    // Add dynamic_variables for contact variable substitution
    if (params.dynamicData && Object.keys(params.dynamicData).length > 0) {
      if (!requestBody.conversation_initiation_client_data) {
        requestBody.conversation_initiation_client_data = {};
      }
      requestBody.conversation_initiation_client_data.dynamic_variables = params.dynamicData;
      logger.info(`   Dynamic data: [redacted]`);
    }

    logger.info(`📤 [OutboundCallService] POST /convai/twilio/outbound-call`);
    logger.info(`   Payload: [redacted]`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(`${this.baseUrl}/convai/twilio/outbound-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseText = await response.text();
      logger.info(`📥 [OutboundCallService] Response status: ${response.status}`);
      logger.info(`📥 [OutboundCallService] Response body: ${responseText}`);

      if (!response.ok) {
        const errorMsg = `ElevenLabs outbound call failed: ${response.status} - ${responseText}`;
        logger.error(`❌ [OutboundCallService] ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const result = JSON.parse(responseText);

      if (result.success === false) {
        logger.error(`❌ [OutboundCallService] Call failed to initiate: ${result.message || 'Unknown ElevenLabs error'}`);
      } else {
        logger.info(`✅ [OutboundCallService] Call initiated successfully`);
      }
      logger.info(`   Success: ${result.success}`);
      logger.info(`   Message: ${result.message}`);
      logger.info(`   Conversation ID: ${result.conversationId || result.conversation_id}`);
      logger.info(`   Call SID: ${result.callSid || result.call_sid || 'NULL'}`);
      logger.info(`   Raw ElevenLabs Response: [redacted]`);

      // Handle both camelCase and snake_case response formats for compatibility
      return {
        success: result.success,
        message: result.message,
        conversationId: result.conversationId || result.conversation_id || null,
        callSid: result.callSid || result.call_sid || null,
      };
    } catch (error) {
      logger.error(`❌ [OutboundCallService] Error initiating call:`, error);
      throw error;
    }
  }

  /**
   * Helper to create conversation config override for custom prompts/messages
   */
  static createConfigOverride(options: {
    customPrompt?: string;
    firstMessage?: string;
  }): OutboundCallParams['conversationInitiationClientData'] | undefined {
    if (!options.customPrompt && !options.firstMessage) {
      return undefined;
    }

    return {
      conversationConfigOverride: {
        agent: {
          ...(options.customPrompt && {
            prompt: {
              prompt: options.customPrompt,
            },
          }),
          ...(options.firstMessage && {
            firstMessage: options.firstMessage,
          }),
        },
      },
    };
  }
}
