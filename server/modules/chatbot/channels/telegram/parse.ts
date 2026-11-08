/**
 * Telegram update parsing. Pure: no network, no storage. Runs only after verifyTelegramSecretToken has passed.
 *
 * Mapping to the normalised shape:
 *   externalThreadId  = chat.id
 *   externalMessageId = "<chat.id>:<message_id>". Telegram message ids are unique only within one chat.
 *   sender.externalId = from.id, falling back to chat.id when from is absent.
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

function idText(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d{1,32}$/.test(value)) return value;
  return null;
}

function displayNameOf(from: Json | null): string | null {
  if (!from) return null;
  const parts = [from.first_name, from.last_name].filter((p): p is string => typeof p === "string" && p.length > 0);
  if (parts.length > 0) return parts.join(" ");
  return typeof from.username === "string" && from.username.length > 0 ? from.username : null;
}

/** Picks the content kind and attachments from a Telegram message. Text wins over captions. */
function classify(message: Json): { kind: InboundContentKind; attachments: InboundAttachment[] } {
  if (typeof message.text === "string") {
    return { kind: "text", attachments: [] };
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    const ref = isRecord(largest) && typeof largest.file_id === "string" ? largest.file_id : null;
    const size = isRecord(largest) && typeof largest.file_size === "number" ? largest.file_size : null;
    return {
      kind: "image",
      attachments: ref ? [{ kind: "image", externalRef: ref, mimeType: "image/jpeg", sizeBytes: size }] : [],
    };
  }
  const media: Array<[string, InboundAttachment["kind"]]> = [
    ["voice", "audio"],
    ["audio", "audio"],
    ["video", "video"],
    ["video_note", "video"],
    ["document", "file"],
  ];
  for (const [field, kind] of media) {
    const item = message[field];
    if (isRecord(item) && typeof item.file_id === "string") {
      return {
        kind,
        attachments: [
          {
            kind,
            externalRef: item.file_id,
            mimeType: typeof item.mime_type === "string" ? item.mime_type : null,
            sizeBytes: typeof item.file_size === "number" ? item.file_size : null,
          },
        ],
      };
    }
  }
  if (isRecord(message.location)) {
    return { kind: "location", attachments: [] };
  }
  return { kind: "unknown", attachments: [] };
}

export function parseTelegramUpdate(raw: RawWebhook, accountId: string): InboundParseResult[] {
  let body: unknown;
  try {
    body = JSON.parse(raw.rawBody);
  } catch {
    return [{ kind: "ignored", reason: "invalid_json" }];
  }
  if (!isRecord(body)) return [{ kind: "ignored", reason: "not_an_object" }];

  const message = body.message;
  if (!isRecord(message)) return [{ kind: "ignored", reason: "no_message_in_update" }];

  const chatId = idText(isRecord(message.chat) ? message.chat.id : undefined);
  const messageId = idText(message.message_id);
  if (!chatId || !messageId) return [{ kind: "ignored", reason: "missing_chat_or_message_id" }];

  const from = isRecord(message.from) ? message.from : null;
  if (from && from.is_bot === true) return [{ kind: "ignored", reason: "bot_sender" }];

  const senderId = (from ? idText(from.id) : null) ?? chatId;
  const { kind, attachments } = classify(message);
  const sentAt =
    typeof message.date === "number" && Number.isFinite(message.date)
      ? new Date(message.date * 1000)
      : raw.receivedAt;

  return [
    {
      kind: "message",
      message: {
        channel: "telegram",
        accountId,
        externalThreadId: chatId,
        externalMessageId: `${chatId}:${messageId}`,
        sender: { externalId: senderId, displayName: displayNameOf(from) },
        contentKind: kind,
        text: kind === "text" ? (message.text as string) : typeof message.caption === "string" ? message.caption : null,
        attachments,
        sentAt,
      },
    },
  ];
}
