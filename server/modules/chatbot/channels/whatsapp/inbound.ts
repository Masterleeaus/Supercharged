/**
 * Parses a verified Twilio WhatsApp webhook into the shared channel shape. Pure: no network, no storage.
 *
 * One Twilio request carries one event: either an inbound message or a delivery status callback.
 */
import type {
  DeliveryStatus,
  InboundAttachment,
  InboundContentKind,
  InboundParseResult,
  RawWebhook,
} from "../../contracts/index.ts";
import { formFields, parseFormEntries } from "../framework.ts";
import { normaliseWhatsappAddress } from "./twilio.ts";

/** Twilio sends at most ten media items per message. */
const MAX_MEDIA_ITEMS = 10;

const STATUS_MAP: Record<string, DeliveryStatus | null> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
  undelivered: "failed",
  queued: null,
  accepted: null,
  sending: null,
  scheduled: null,
  canceled: null,
};

const CONTENT_KIND_MAP: Record<string, InboundContentKind> = {
  text: "text",
  image: "image",
  audio: "audio",
  video: "video",
  document: "file",
  location: "location",
  interactive: "interactive",
  button: "interactive",
};

function attachmentKindFor(contentType: string | null): InboundAttachment["kind"] {
  if (!contentType) return "file";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "file";
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value : null;
}

export function parseTwilioInbound(raw: RawWebhook, accountId: string): InboundParseResult[] {
  const fields = formFields(parseFormEntries(raw.rawBody));

  const messageStatus = fields.get("MessageStatus");
  if (messageStatus !== undefined && messageStatus !== "received") {
    const status = STATUS_MAP[messageStatus.toLowerCase()];
    const messageSid = fields.get("MessageSid") ?? fields.get("SmsSid");
    if (status === undefined || status === null || !messageSid) {
      return [{ kind: "ignored", reason: `status_${messageStatus.toLowerCase()}` }];
    }
    const errorCode = fields.get("ErrorCode");
    return [
      {
        kind: "status",
        update: {
          channel: "whatsapp",
          accountId,
          externalMessageId: messageSid,
          status,
          // Only the numeric Twilio error code is kept. The error text can echo customer data.
          reason: errorCode && /^\d{1,8}$/.test(errorCode) ? `twilio_error_${errorCode}` : null,
          occurredAt: raw.receivedAt,
        },
      },
    ];
  }

  const messageSid = fields.get("MessageSid") ?? fields.get("SmsSid");
  if (!messageSid) {
    return [{ kind: "ignored", reason: "message_id_missing" }];
  }

  const senderId = normaliseWhatsappAddress(fields.get("WaId")) ?? normaliseWhatsappAddress(fields.get("From"));
  if (!senderId) {
    return [{ kind: "ignored", reason: "sender_missing" }];
  }

  const twilioType = (fields.get("MessageType") ?? "text").toLowerCase();
  const contentKind: InboundContentKind = CONTENT_KIND_MAP[twilioType] ?? "unknown";

  const attachments: InboundAttachment[] = [];
  const numMedia = Number.parseInt(fields.get("NumMedia") ?? "0", 10);
  const mediaCount = Number.isFinite(numMedia) ? Math.min(Math.max(numMedia, 0), MAX_MEDIA_ITEMS) : 0;
  for (let index = 0; index < mediaCount; index += 1) {
    const externalRef = nonEmpty(fields.get(`MediaUrl${index}`));
    if (!externalRef) continue;
    const mimeType = nonEmpty(fields.get(`MediaContentType${index}`));
    attachments.push({
      kind: attachmentKindFor(mimeType),
      externalRef,
      mimeType,
      sizeBytes: null,
    });
  }

  const displayName = nonEmpty(fields.get("ProfileName"))?.trim() ?? null;

  return [
    {
      kind: "message",
      message: {
        channel: "whatsapp",
        accountId,
        externalThreadId: senderId,
        externalMessageId: messageSid,
        sender: { externalId: senderId, displayName },
        contentKind,
        // Interactive replies carry their label in a button field this port does not map yet, so text stays null.
        text: contentKind === "interactive" ? null : nonEmpty(fields.get("Body")),
        attachments,
        sentAt: raw.receivedAt,
      },
    },
  ];
}
