/**
 * Port of ConversationExportService (Chatbot extension, System/Services/ConversationExportService.php)
 * for the txt, csv and json formats.
 *
 * PDF is not ported. It needed dompdf and a Blade view. Pure function: the caller passes the rows.
 * Internal notes are excluded, as the PHP does through widgetHistories().
 */
import type { ConversationRecord, MessageRecord } from "./chatbot-storage.ts";

export type ConversationExportFormat = "txt" | "csv" | "json";

export interface ExportFile {
  contentType: string;
  fileName: string;
  body: string;
}

export interface ExportInput {
  conversation: ConversationRecord;
  chatbotTitle: string | null;
  messages: MessageRecord[];
  now: Date;
}

/** Y-m-d H:i:s in UTC. The PHP used the app timezone, which the port does not read. */
function formatDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

/** fputcsv(): quote a field that contains a comma, quote, backslash, space, or CR, LF or tab. */
function csvField(value: string): string {
  if (!/[,"\\ \t\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function csvLine(fields: string[]): string {
  return fields.map(csvField).join(",") + "\n";
}

function visibleMessages(messages: MessageRecord[]): MessageRecord[] {
  return messages
    .filter((message) => !message.isInternalNote)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function exportConversation(input: ExportInput, format: ConversationExportFormat | string): ExportFile {
  const messages = visibleMessages(input.messages);
  const id = input.conversation.id;

  if (format === "csv") {
    const rows = messages.map((message) =>
      csvLine([formatDateTime(message.createdAt), message.role.toUpperCase(), message.message]),
    );
    return {
      contentType: "text/csv",
      fileName: `conversation-${id}.csv`,
      body: csvLine(["Timestamp", "Role", "Message"]) + rows.join(""),
    };
  }

  if (format === "json") {
    const data = {
      conversation_id: id,
      chatbot: input.chatbotTitle ?? "Chatbot",
      exported_at: input.now.toISOString(),
      messages: messages.map((message) => ({
        role: message.role,
        message: message.message,
        media_url: message.mediaUrl,
        media_name: message.mediaName,
        timestamp: message.createdAt.toISOString(),
      })),
    };
    return {
      contentType: "application/json",
      fileName: `conversation-${id}.json`,
      body: JSON.stringify(data, null, 4),
    };
  }

  // Default branch, as in the PHP match(): anything unrecognised is exported as text.
  const body = messages
    .map((message) => `[${formatDateTime(message.createdAt)}] [${message.role.toUpperCase()}] ${message.message}\n\n`)
    .join("");
  return {
    contentType: "text/plain",
    fileName: `conversation-${id}.txt`,
    body,
  };
}
