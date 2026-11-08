/**
 * Messenger webhook parsing. Pure: no network, no storage. Runs only after verifyMessengerSignature has passed.
 *
 * Mapping to the normalised shape:
 *   accountId         = entry[].id (the Page id). Events for another page are ignored.
 *   externalThreadId  = sender.id (the page-scoped user id)
 *   externalMessageId = message.mid
 *   Delivery receipts become "delivered" status updates, one per mid.
 *
 * Echoes (is_echo: true) are ignored. The legacy PHP answered its own echoes, which can loop.
 * Read receipts carry only a watermark, not a message id, so they are ignored.
 */
import type {
  InboundAttachment,
  InboundContentKind,
  InboundParseResult,
  RawWebhook,
} from "../../contracts/index.ts";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Page id that the payload names, read without parsing the rest. Null when absent. */
export function messengerPageId(rawBody: string): string | null {
  try {
    const body: unknown = JSON.parse(rawBody);
    if (!isRecord(body) || !Array.isArray(body.entry)) return null;
    const first = body.entry[0];
    if (!isRecord(first)) return null;
    const id = first.id;
    return typeof id === "string" && /^\d{1,32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const MEDIA_KINDS: Record<string, InboundAttachment["kind"]> = {
  image: "image",
  audio: "audio",
  video: "video",
  file: "file",
};

function attachmentsOf(message: Json): { kind: InboundContentKind; attachments: InboundAttachment[] } {
  if (typeof message.text === "string") return { kind: "text", attachments: [] };
  const list = Array.isArray(message.attachments) ? message.attachments : [];
  const first = list[0];
  if (!isRecord(first) || typeof first.type !== "string") return { kind: "unknown", attachments: [] };
  if (first.type === "location") return { kind: "location", attachments: [] };
  const mediaKind = MEDIA_KINDS[first.type];
  if (!mediaKind) return { kind: "unknown", attachments: [] };
  const payload = isRecord(first.payload) ? first.payload : {};
  const url = typeof payload.url === "string" ? payload.url : null;
  return {
    kind: mediaKind,
    attachments: url ? [{ kind: mediaKind, externalRef: url, mimeType: null, sizeBytes: null }] : [],
  };
}

function timestampDate(value: unknown, fallback: Date): Date {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value) : fallback;
}

export function parseMessengerEvents(raw: RawWebhook, accountId: string): InboundParseResult[] {
  let body: unknown;
  try {
    body = JSON.parse(raw.rawBody);
  } catch {
    return [{ kind: "ignored", reason: "invalid_json" }];
  }
  if (!isRecord(body) || body.object !== "page" || !Array.isArray(body.entry)) {
    return [{ kind: "ignored", reason: "not_a_page_event" }];
  }

  const results: InboundParseResult[] = [];
  for (const entry of body.entry) {
    if (!isRecord(entry)) continue;
    if (entry.id !== accountId) {
      results.push({ kind: "ignored", reason: "account_mismatch" });
      continue;
    }
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of events) {
      results.push(...parseEvent(event, raw, accountId));
    }
  }
  return results;
}

function parseEvent(event: unknown, raw: RawWebhook, accountId: string): InboundParseResult[] {
  if (!isRecord(event)) return [{ kind: "ignored", reason: "malformed_event" }];
  const sender = isRecord(event.sender) ? event.sender : null;
  const senderId = sender && typeof sender.id === "string" && sender.id.length > 0 ? sender.id : null;
  const sentAt = timestampDate(event.timestamp, raw.receivedAt);

  if (isRecord(event.message)) {
    const message = event.message;
    if (message.is_echo === true) return [{ kind: "ignored", reason: "echo" }];
    if (!senderId) return [{ kind: "ignored", reason: "missing_sender" }];
    if (typeof message.mid !== "string" || message.mid.length === 0) {
      return [{ kind: "ignored", reason: "missing_message_id" }];
    }
    const { kind, attachments } = attachmentsOf(message);
    return [
      {
        kind: "message",
        message: {
          channel: "messenger",
          accountId,
          externalThreadId: senderId,
          externalMessageId: message.mid,
          sender: { externalId: senderId, displayName: null },
          contentKind: kind,
          text: typeof message.text === "string" ? message.text : null,
          attachments,
          sentAt,
        },
      },
    ];
  }

  if (isRecord(event.postback)) {
    if (!senderId) return [{ kind: "ignored", reason: "missing_sender" }];
    const postback = event.postback;
    const id = typeof postback.mid === "string" && postback.mid.length > 0 ? postback.mid : `postback:${senderId}:${sentAt.getTime()}`;
    return [
      {
        kind: "message",
        message: {
          channel: "messenger",
          accountId,
          externalThreadId: senderId,
          externalMessageId: id,
          sender: { externalId: senderId, displayName: null },
          contentKind: "interactive",
          text: typeof postback.title === "string" ? postback.title : null,
          attachments: [],
          sentAt,
        },
      },
    ];
  }

  if (isRecord(event.delivery)) {
    const mids = Array.isArray(event.delivery.mids) ? event.delivery.mids : [];
    const occurredAt = timestampDate(event.delivery.watermark, raw.receivedAt);
    const updates = mids
      .filter((mid): mid is string => typeof mid === "string" && mid.length > 0)
      .map((mid): InboundParseResult => ({
        kind: "status",
        update: { channel: "messenger", accountId, externalMessageId: mid, status: "delivered", reason: null, occurredAt },
      }));
    return updates.length > 0 ? updates : [{ kind: "ignored", reason: "delivery_without_mids" }];
  }

  if (isRecord(event.read)) return [{ kind: "ignored", reason: "read_watermark_only" }];
  return [{ kind: "ignored", reason: "unsupported_event" }];
}
