/**
 * Wire types for the staff inbox. They mirror server/modules/chatbot/agent-routes/contracts.ts.
 * The server serialises Date as an ISO string, so timestamps are strings here.
 */

export type AgentHandler = "ai" | "human";
export type TicketStatus = "new" | "closed";
export type MessageRole = "user" | "assistant";

export interface InboxConversation {
  id: string;
  chatbotId: string;
  /** Channel key such as "web", "whatsapp" or "telegram". Shown as a label, never as a fixed list. */
  channel: string;
  handler: AgentHandler;
  ticketStatus: TicketStatus;
  /** Staff member who took over. Null while the AI handles the chat. */
  handlerStaffId: string | null;
  updatedAt: string;
  /**
   * PENDING BACKEND. Not in the mounted response today. The row shows an unread badge only when this
   * field is a number, so the UI needs no change when the backend adds it.
   */
  unreadCount?: number;
}

export interface InboxMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  message: string;
  /** Internal notes are visible to staff only and never reach the customer. */
  isInternalNote: boolean;
  /** Set on staff messages. Null for customer and AI messages. */
  staffId: string | null;
  createdAt: string;
}

/** Response of GET /inbox. */
export interface InboxPage {
  items: InboxConversation[];
  page: number;
  perPage: number;
  total: number;
}

/** Response of GET /conversations/:id. */
export interface ConversationThread {
  conversation: InboxConversation;
  messages: InboxMessage[];
}

/** Response of POST /conversations/:id/takeover, /handback and /close. */
export interface ConversationActionResult {
  conversation: InboxConversation;
}

/** Response of POST /conversations/:id/messages. */
export interface StaffReplyResult {
  message: InboxMessage;
  deliveredToCustomer: boolean;
  deliveryFailed: boolean;
}

/** Server limit for one staff message (MAX_REPLY_LENGTH in agent-routes/validation.ts). */
export const MAX_REPLY_LENGTH = 10000;
/** Server page size limit (MAX_PAGE_SIZE in agent-routes/validation.ts). */
export const MAX_PAGE_SIZE = 100;
export const PAGE_SIZE = 30;

/** Roles that the server allows to write. The client hides write controls for a manager, but the server decides. */
export const READ_ONLY_ROLES = ["manager"] as const;
