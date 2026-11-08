/**
 * WhatsApp channel (Twilio). Public surface for the channels folder and for the wiring owner.
 */
export {
  createWhatsappProvider,
  isWhatsappChannelEnabled,
  WHATSAPP_CHANNEL_FLAG,
  type WhatsappProviderOptions,
} from "./provider.ts";
export {
  computeTwilioSignature,
  normaliseWhatsappAddress,
  TWILIO_SIGNATURE_HEADER,
} from "./twilio.ts";
export { parseTwilioInbound } from "./inbound.ts";
export { sendTwilioWhatsapp, TWILIO_API_BASE } from "./outbound.ts";
