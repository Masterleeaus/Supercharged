import type { Express, Request, Response } from "express";
import { validateTwilioWebhook } from "../../middleware/webhookValidation";
import { handleTwilioVoiceWebhook, handleIncomingCallWebhook, handleTwilioStatusWebhook, handleTwilioRecordingWebhook, handleFlowVoiceAnswer, handleFlowNode, handleFlowGather, handleFlowContinue, handleFlowStatus, handleElevenLabsWebhook, handleRAGToolWebhook, handleAppointmentToolWebhook, handleFormSubmissionWebhook, handlePlayAudioToolWebhook } from "../../routes/webhook-routes";
import { getDomain } from "../../utils/domain";
import { validateAppointmentWebhookToken } from "../../services/appointment-elevenlabs-tool";
import { createProviderWebhookRateLimit, readTwilioAccountSid, TWILIO_ACCOUNT_SID_PATTERN } from "../../middleware/provider-webhook-rate-limit";

export function registerProviderWebhookRoutes(app: Express): void {
  // Phone Numbers routes are now in server/routes/phone-routes.ts

  // Per-account rate limits for provider webhooks. Twilio is keyed on the verified AccountSid,
  // which is only read after validateTwilioWebhook has checked the signature. ElevenLabs is
  // keyed on IP, since its signature check runs inside the handler.
  const twilioWebhookRateLimit = createProviderWebhookRateLimit({
    provider: "twilio",
    windowMs: 60_000,
    maxRequests: 160,
    readAccountId: readTwilioAccountSid,
    accountIdPattern: TWILIO_ACCOUNT_SID_PATTERN,
  });
  const elevenLabsWebhookRateLimit = createProviderWebhookRateLimit({
    provider: "elevenlabs",
    windowMs: 60_000,
    maxRequests: 160,
  });

  // Twilio webhook endpoints (validated with Twilio signature verification, then rate limited)
  app.post("/api/webhooks/twilio/voice", validateTwilioWebhook, twilioWebhookRateLimit, handleTwilioVoiceWebhook); // Outbound campaign calls
  app.post("/api/webhooks/twilio/incoming", validateTwilioWebhook, twilioWebhookRateLimit, handleIncomingCallWebhook); // Incoming calls to purchased numbers
  app.post("/api/webhooks/twilio/status", validateTwilioWebhook, twilioWebhookRateLimit, handleTwilioStatusWebhook);
  app.post("/api/webhooks/twilio/recording", validateTwilioWebhook, twilioWebhookRateLimit, handleTwilioRecordingWebhook);

  // Flow-based execution webhooks (validated with Twilio signature verification, then rate limited)
  app.post("/api/webhooks/twilio/flow/answer", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowVoiceAnswer);
  app.post("/api/webhooks/twilio/flow/node", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowNode);
  app.post("/api/webhooks/twilio/flow/gather", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowGather);
  app.post("/api/webhooks/twilio/flow/continue", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowContinue);
  app.post("/api/webhooks/twilio/flow/status", validateTwilioWebhook, twilioWebhookRateLimit, handleFlowStatus);

  // ElevenLabs webhook endpoints (no authentication - called by ElevenLabs)
  app.post("/api/webhooks/elevenlabs", elevenLabsWebhookRateLimit, handleElevenLabsWebhook); // Call completion notifications
  // RAG knowledge base tool - supports both URL-based token (primary) and header token (fallback)
  app.post("/api/webhooks/elevenlabs/rag-tool/:token/:agentId", handleRAGToolWebhook); // New: token in URL
  app.post("/api/webhooks/elevenlabs/rag-tool/:agentId", handleRAGToolWebhook); // Legacy: header auth
  // Appointment booking tool webhook - called by ElevenLabs when appointment node executes
  app.post("/api/webhooks/elevenlabs/appointment/:token/:agentId", handleAppointmentToolWebhook);
  // Form submission tool webhook - called by ElevenLabs when form node executes
  app.post("/api/webhooks/elevenlabs/form/:token/:formId/:agentId", handleFormSubmissionWebhook);
  // Play audio tool webhook - called by ElevenLabs when play_audio node executes
  // audioUrl is validated before the handler runs: https only, parsed with URL, host must be this app's own
  // domain (no external or private/loopback hosts). Relative paths resolve against the own domain.
  // Protected by the same URL-token mechanism as the appointment tool (validateAppointmentWebhookToken).
  app.post("/api/elevenlabs/tools/play-audio/:token/:agentId", (req: Request, res: Response, next: () => void) => {
    if (!validateAppointmentWebhookToken(req.params.token)) {
      res.status(401).json({ success: false, error: "Unauthorized: Invalid authentication token" });
      return;
    }
    const rawDomain = getDomain();
    let ownHost: string | undefined;
    try {
      ownHost = new URL(rawDomain.includes("://") ? rawDomain : `https://${rawDomain}`).host;
    } catch {
      ownHost = undefined;
    }
    if (!ownHost) {
      res.status(500).json({ error: "Audio host not configured" });
      return;
    }
    const rawAudioUrl = req.body?.audioUrl;
    if (typeof rawAudioUrl !== "string" || rawAudioUrl.length === 0 || rawAudioUrl.length > 2048) {
      res.status(400).json({ error: "Invalid audioUrl" });
      return;
    }
    let parsedAudio: URL;
    try {
      parsedAudio = new URL(rawAudioUrl, `https://${ownHost}`);
    } catch {
      res.status(400).json({ error: "Invalid audioUrl" });
      return;
    }
    const audioHost = parsedAudio.hostname.toLowerCase();
    const isPrivateHost =
      audioHost === "localhost" ||
      audioHost === "0.0.0.0" ||
      audioHost === "[::1]" ||
      audioHost.startsWith("127.") ||
      audioHost.startsWith("10.") ||
      audioHost.startsWith("192.168.") ||
      audioHost.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(audioHost);
    if (parsedAudio.protocol !== "https:" || isPrivateHost || parsedAudio.host !== ownHost) {
      res.status(400).json({ error: "audioUrl must be an https URL on this application's domain" });
      return;
    }
    next();
  }, handlePlayAudioToolWebhook);
}
