/**
 * Service contracts for the staff reply and handoff HTTP layer.
 *
 * The inbox and conversation domains are implemented elsewhere. This slice depends only on these
 * interfaces and never imports from server/modules/chatbot/inbox/. Every method takes companyId as its
 * first argument, and every implementation must call requireCompanyId and read or write only rows that
 * carry that company id. A missing or foreign conversation resolves to null, never to another tenant's row.
 */

export type AgentHandler = "ai" | "human";
export type AgentTicketStatus = "new" | "closed";
export type AgentMessageRole = "user" | "assistant";

export interface AgentConversation {
  id: string;
  companyId: string;
  chatbotId: string;
  channel: string;
  /** "human" once an agent has taken over, "ai" while the bot handles the chat. */
  handler: AgentHandler;
  ticketStatus: AgentTicketStatus;
  /** Set when a staff member took over; cleared on handback. */
  handlerStaffId: string | null;
  updatedAt: Date;
}

export interface AgentMessage {
  id: string;
  conversationId: string;
  role: AgentMessageRole;
  message: string;
  /** Internal notes are visible to staff only and never reach the customer. */
  isInternalNote: boolean;
  /** Staff member who wrote an assistant-side message. Null for customer and AI messages. */
  staffId: string | null;
  createdAt: Date;
}

export interface InboxQuery {
  handler?: AgentHandler;
  /** Omit or "all" for both statuses. */
  ticketStatus?: AgentTicketStatus | "all";
  search?: string;
  page: number;
  perPage: number;
}

export interface InboxPage {
  items: AgentConversation[];
  page: number;
  perPage: number;
  total: number;
}

export interface AgentInboxService {
  listInbox(companyId: string, query: InboxQuery): Promise<InboxPage>;
}

export interface ConversationWithMessages {
  conversation: AgentConversation;
  messages: AgentMessage[];
}

export interface StaffMessageInput {
  conversationId: string;
  staffId: string;
  message: string;
  isInternalNote: boolean;
}

export interface AgentConversationService {
  /** Staff view: includes internal notes. Returns null when the conversation is not in this company. */
  getConversation(companyId: string, conversationId: string): Promise<ConversationWithMessages | null>;
  /** Persists a staff message. Returns null when the conversation is not in this company. */
  appendStaffMessage(companyId: string, input: StaffMessageInput): Promise<AgentMessage | null>;
  /** Takeover sets handler "human" and records the staff member; handback sets "ai" and clears them. */
  setHandler(
    companyId: string,
    conversationId: string,
    handler: AgentHandler,
    staffId: string,
  ): Promise<AgentConversation | null>;
  setTicketStatus(
    companyId: string,
    conversationId: string,
    status: "closed",
    staffId: string,
  ): Promise<AgentConversation | null>;
}

/**
 * Sends a staff reply to the customer's channel (WhatsApp, Telegram, web widget). The router calls this only
 * for messages that are not internal notes. A failure is reported in the response and never rolls back the
 * persisted message, matching the PHP controller's try/catch around the channel send.
 */
export interface CustomerDelivery {
  deliver(input: { companyId: string; conversationId: string; message: AgentMessage }): Promise<void>;
}

/** Out-of-scope transport stub. Nothing is sent. */
export const NOOP_CUSTOMER_DELIVERY: CustomerDelivery = {
  async deliver() {},
};
