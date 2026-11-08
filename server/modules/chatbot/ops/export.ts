/**
 * Conversation export. Port of ConversationExportService.php for txt, csv and json.
 * PDF returns 501 and matches the Desk's existing behaviour in chatbot-service.ts (no dompdf here).
 *
 * Differences from the PHP, all recorded in DECISIONS.md:
 * - Every read is company-scoped, and a row whose companyId differs is dropped before rendering.
 * - CSV cells that start with = + - @ or a tab or CR are prefixed with an apostrophe, so a spreadsheet cannot run them.
 * - The file name uses only the characters [A-Za-z0-9_-] from the conversation id, so it cannot break the header.
 */
import { requireCompanyId } from "../chatbot-scope.ts";

export type ExportFormat = "txt" | "csv" | "json";

export interface ExportConversation {
  id: string;
  companyId: string;
  chatbotId: string;
}

export interface ExportMessage {
  id: string;
  companyId: string;
  conversationId: string;
  role: string;
  message: string;
  mediaUrl: string | null;
  mediaName: string | null;
  isInternalNote: boolean;
  createdAt: Date;
}

export interface ExportReader {
  findConversation(companyId: string, conversationId: string): Promise<ExportConversation | null>;
  chatbotTitle(companyId: string, chatbotId: string): Promise<string | null>;
  /** Rows may include internal notes. The export filters them out. */
  listMessages(companyId: string, conversationId: string): Promise<ExportMessage[]>;
}

export type ExportResult =
  | { kind: "file"; status: 200; contentType: string; fileName: string; body: string }
  | { kind: "not_found"; status: 404; error: "not_found" }
  | { kind: "unsupported"; status: 501; error: "not_implemented"; reason: string };

export const PDF_UNSUPPORTED_REASON = "PDF export is not available in this module";

/** Accepts only the characters that are safe in a Content-Disposition file name. */
export function safeFileStem(conversationId: string): string {
  return conversationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 191) || "conversation";
}

/** Y-m-d H:i:s in UTC. */
function formatDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Spreadsheet formula guard. A leading apostrophe makes the cell text, not a formula. */
export function csvSafeCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** fputcsv() quoting: wrap when the field has a comma, quote, backslash, space, or line break. */
function csvField(value: string): string {
  if (!/[,"\\ \t\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function csvLine(fields: string[]): string {
  return fields.map(csvField).join(",") + "\n";
}

/** Keeps the rows for this company that are visible to the customer, oldest first. */
export function visibleExportMessages(companyId: string, conversationId: string, messages: ExportMessage[]): ExportMessage[] {
  return messages
    .filter((row) => row.companyId === companyId && row.conversationId === conversationId && !row.isInternalNote)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

export function renderExport(
  format: ExportFormat | string,
  input: { conversationId: string; chatbotTitle: string | null; messages: ExportMessage[]; now: Date },
): { contentType: string; fileName: string; body: string } {
  const stem = safeFileStem(input.conversationId);
  const { messages } = input;

  if (format === "csv") {
    const rows = messages.map((row) =>
      csvLine([formatDateTime(row.createdAt), row.role.toUpperCase(), csvSafeCell(row.message)]),
    );
    return { contentType: "text/csv", fileName: `conversation-${stem}.csv`, body: csvLine(["Timestamp", "Role", "Message"]) + rows.join("") };
  }

  if (format === "json") {
    const data = {
      conversation_id: input.conversationId,
      chatbot: input.chatbotTitle ?? "Chatbot",
      exported_at: input.now.toISOString(),
      messages: messages.map((row) => ({
        role: row.role,
        message: row.message,
        media_url: row.mediaUrl,
        media_name: row.mediaName,
        timestamp: row.createdAt.toISOString(),
      })),
    };
    return { contentType: "application/json", fileName: `conversation-${stem}.json`, body: JSON.stringify(data, null, 4) };
  }

  // Default branch, as in the PHP match(): anything unrecognised is exported as text.
  const body = messages
    .map((row) => `[${formatDateTime(row.createdAt)}] [${row.role.toUpperCase()}] ${row.message}\n\n`)
    .join("");
  return { contentType: "text/plain", fileName: `conversation-${stem}.txt`, body };
}

export async function exportConversation(
  reader: ExportReader,
  companyId: string,
  conversationId: string,
  format: ExportFormat | "pdf" | string,
  now: Date = new Date(),
): Promise<ExportResult> {
  const cid = requireCompanyId(companyId);
  if (format === "pdf") {
    return { kind: "unsupported", status: 501, error: "not_implemented", reason: PDF_UNSUPPORTED_REASON };
  }

  const conversation = await reader.findConversation(cid, conversationId);
  if (!conversation || conversation.companyId !== cid) {
    return { kind: "not_found", status: 404, error: "not_found" };
  }

  const title = await reader.chatbotTitle(cid, conversation.chatbotId);
  const messages = visibleExportMessages(cid, conversation.id, await reader.listMessages(cid, conversation.id));
  const rendered = renderExport(format, { conversationId: conversation.id, chatbotTitle: title, messages, now });
  return { kind: "file", status: 200, ...rendered };
}
