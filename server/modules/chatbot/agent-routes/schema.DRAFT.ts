/*
 * DRAFT fragment for the staff reply and handoff layer. Not wired into shared/schema.ts and not applied to any
 * database. The integration agent spreads these column maps into the matching tables in
 * server/modules/chatbot/schema.DRAFT.ts (or shared/schema.ts once promoted).
 *
 * Needs no new table. The draft already has:
 *   chatbot_messages.is_internal_note   (notes are staff-only)
 *   chatbot_conversations.connect_agent_at  (non-null = human handler; null = AI)
 *   chatbot_conversations.ticket_status     (new | closed)
 * The two columns below are the only additions.
 */
import { varchar } from "drizzle-orm/pg-core";

/** Spread into chatbotMessages. Records which staff member wrote an assistant-side message. */
export const chatbotMessageStaffColumns = {
  staffId: varchar("staff_id", { length: 64 }),
};

/** Spread into chatbotConversations. Records which staff member is handling the chat while a human is connected. */
export const chatbotConversationHandlerColumns = {
  handlerStaffId: varchar("handler_staff_id", { length: 64 }),
};
