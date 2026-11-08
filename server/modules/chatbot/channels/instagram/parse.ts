/**
 * Pure parsing of a verified Instagram webhook. No network, no storage.
 * Every entry and every messaging event is parsed, in order. The PHP read only entry 0, messaging 0.
 * Outbound echoes (is_echo) are ignored, so the bot does not answer its own replies.
 */
import type {
  DeliveryStatus,
  InboundAttachment,
  InboundContentKind,
  InboundParseResult,
  RawWebhook,
} from "../../contracts/index.ts";
import { INSTAGRAM_CHANNEL_KIND } from "./config.ts";
import { parseJsonObject } from "./http.ts";

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Meta timestamps are milliseconds since the epoch. A missing or bad one falls back to the receive time. */
function timeOf(value: unknown, fallback: Date): Date {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value) : fallback;
}

/** Returns the Instagram account id named by the first entry, or null. Pure read of the payload. */
export function accountIdOf(rawBody: string): string | null {
  const payload = parseJsonObject(rawBody);
  const entry = asObject(asArray(payload?.entry)[0]);
  return asString(entry?.id);
}

function attachmentContent(
  attachment: Json,
): { contentKind: InboundContentKind; attachment: InboundAttachment | null } {
  const type = asString(attachment.type);
  const url = asString(asObject(attachment.payload)?.url);
  if (type === "image" || type === "video" || type === "audio") {
    return {
      contentKind: type,
      attachment: url ? { kind: type, externalRef: url, mimeType: null, sizeBytes: null } : null,
    };
  }
  // Shares, story mentions, reels and likes have no media the bot can fetch. They are reported as unknown.
  return { contentKind: "unknown", attachment: null };
}

/** Maps one messaging event to a message, a status update, or an ignore. */
function parseMessagingEvent(
  event: Json,
  accountId: string,
  receivedAt: Date,
): InboundParseResult[] {
  const sender = asObject(event.sender);
  const senderId = asString(sender?.id);

  const delivery = asObject(event.delivery);
  if (delivery) {
    const occurredAt = timeOf(delivery.watermark, receivedAt);
    return asArray(delivery.mids).flatMap((mid): InboundParseResult[] => {
      const id = asString(mid);
      if (!id) return [];
      return [
        {
          kind: "status",
          update: { channel: INSTAGRAM_CHANNEL_KIND, accountId, externalMessageId: id, status: "delivered" as DeliveryStatus, reason: null, occurredAt },
        },
      ];
    });
  }

  const read = asObject(event.read);
  if (read) {
    const mid = asString(read.mid);
    if (!mid) return [{ kind: "ignored", reason: "read_without_message_id" }];
    return [
      {
        kind: "status",
        update: { channel: INSTAGRAM_CHANNEL_KIND, accountId, externalMessageId: mid, status: "read", reason: null, occurredAt: timeOf(read.watermark, receivedAt) },
      },
    ];
  }

  const message = asObject(event.message);
  if (!message) return [{ kind: "ignored", reason: "unsupported_event" }];
  if (message.is_echo === true) return [{ kind: "ignored", reason: "echo" }];
  if (!senderId) return [{ kind: "ignored", reason: "missing_sender" }];

  const externalMessageId = asString(message.mid);
  if (!externalMessageId) return [{ kind: "ignored", reason: "missing_message_id" }];

  const text = asString(message.text);
  const quickReply = asString(asObject(message.quick_reply)?.payload);
  const attachments = asArray(message.attachments).map((item) => asObject(item)).filter((item): item is Json => item !== null);

  let contentKind: InboundContentKind = "unknown";
  let bodyText: string | null = null;
  let inbound: InboundAttachment[] = [];

  if (text) {
    contentKind = "text";
    bodyText = text;
  } else if (quickReply) {
    contentKind = "interactive";
    bodyText = quickReply;
  } else if (attachments.length > 0) {
    const first = attachmentContent(attachments[0]);
    contentKind = first.contentKind;
    inbound = first.attachment ? [first.attachment] : [];
  }

  return [
    {
      kind: "message",
      message: {
        channel: INSTAGRAM_CHANNEL_KIND,
        accountId,
        externalThreadId: senderId,
        externalMessageId,
        sender: { externalId: senderId, displayName: null },
        contentKind,
        text: bodyText,
        attachments: inbound,
        sentAt: timeOf(event.timestamp, receivedAt),
      },
    },
  ];
}

/**
 * Parses a verified payload. Anything that is not an Instagram payload for this account yields ignored results,
 * never a message. The caller must verify the signature before calling this.
 */
export function parseInstagramPayload(raw: RawWebhook, accountId: string): InboundParseResult[] {
  const payload = parseJsonObject(raw.rawBody);
  if (!payload) return [{ kind: "ignored", reason: "invalid_json" }];
  if (payload.object !== "instagram") return [{ kind: "ignored", reason: "object_not_instagram" }];

  const results: InboundParseResult[] = [];
  for (const item of asArray(payload.entry)) {
    const entry = asObject(item);
    if (!entry) continue;
    if (asString(entry.id) !== accountId) {
      results.push({ kind: "ignored", reason: "account_mismatch" });
      continue;
    }
    for (const event of asArray(entry.messaging)) {
      const messagingEvent = asObject(event);
      if (!messagingEvent) continue;
      results.push(...parseMessagingEvent(messagingEvent, accountId, raw.receivedAt));
    }
  }
  return results;
}
