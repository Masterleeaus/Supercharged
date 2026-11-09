import { logger } from "../../utils/logger";
import type { Express, RequestHandler } from "express";
import { authenticateToken } from "../../middleware/auth";
import { ElevenLabsService } from "../../services/elevenlabs";
import { ElevenLabsPoolService } from "../../services/elevenlabs-pool";
import { campaignExecutor } from "../../services/campaign-executor";
import { checkAdminOrTeamMember } from "../../middleware/admin-auth";
import { markPluginAsRegistered } from "../../plugins/loader";

export async function registerPluginEngineRoutes(app: Express): Promise<void> {
  // Register SIP Engine Plugin dynamically with service injection (only if plugin directory exists)
  try {
    const { importPlugin } = await import('../../utils/plugin-import');
    const sipEnginePlugin = await importPlugin('plugins/sip-engine/index.ts');
    const { canAssignSipAgent } = await import("../../services/sip-credit-guard");
    const { deductSipCallCredits, checkUserCreditBalance } = await import("../../services/credit-service");

    sipEnginePlugin.registerSipEngineRoutes(app, {
      sessionAuthMiddleware: authenticateToken as unknown as import('express').RequestHandler,
      adminAuthMiddleware: checkAdminOrTeamMember as unknown as import('express').RequestHandler,
      sipServices: {
        canAssignSipAgent,
        deductSipCallCredits,
        checkUserCreditBalance,
        ElevenLabsService,
        getCredentialForAgent: ElevenLabsPoolService.getCredentialForAgent.bind(ElevenLabsPoolService),
      },
    });
    markPluginAsRegistered('sip-engine');
    logger.info('✅ SIP Engine Plugin initialized with service injection');
  } catch (err: any) {
    logger.info('[SIP Engine Plugin] Not installed - skipping direct registration');
  }

  // Register REST API Plugin dynamically (only if plugin directory exists)
  try {
    const { importPlugin: importRestPlugin } = await import('../../utils/plugin-import');
    const restApiPlugin = await importRestPlugin('plugins/rest-api/index.ts');

    const { OutboundCallService } = await import("../../services/outbound-call-service");
    let PlivoCallServiceRef: any = null;
    let TwilioOpenAICallServiceRef: any = null;
    try {
      const plivoMod = await import("../../engines/plivo/services/plivo-call.service");
      PlivoCallServiceRef = plivoMod.PlivoCallService;
    } catch (err: any) { logger.warn('Plivo call service not loaded for outbound rest-api calls; continuing without it', { code: err?.code }, 'Routes'); }
    try {
      const twilioMod = await import("../../engines/twilio-openai/services/twilio-openai-call.service");
      TwilioOpenAICallServiceRef = twilioMod.TwilioOpenAICallService;
    } catch (err: any) { logger.warn('Twilio OpenAI call service not loaded for outbound rest-api calls; continuing without it', { code: err?.code }, 'Routes'); }

    await restApiPlugin.registerRestApiRoutes(app, {
      sessionAuthMiddleware: authenticateToken as unknown as import('express').RequestHandler,
      adminAuthMiddleware: checkAdminOrTeamMember as unknown as import('express').RequestHandler,
      callServices: {
        OutboundCallService,
        getCredentialForAgent: ElevenLabsPoolService.getCredentialForAgent.bind(ElevenLabsPoolService),
        PlivoCallService: PlivoCallServiceRef,
        TwilioOpenAICallService: TwilioOpenAICallServiceRef,
        campaignExecutor,
      },
    });
    markPluginAsRegistered('rest-api');
    logger.info('✅ REST API Plugin initialized');
  } catch (err: any) {
    logger.info('[REST API Plugin] Not installed - skipping direct registration');
  }
}
