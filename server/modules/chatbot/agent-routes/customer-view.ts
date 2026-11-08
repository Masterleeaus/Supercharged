/**
 * Customer-visible projection. Anything a customer can see passes through here, and internal notes are
 * dropped before the result leaves the server. Staff responses keep the full list and mark each note.
 */
import type { AgentMessage } from "./contracts.ts";

export interface CustomerMessageView {
  id: string;
  role: AgentMessage["role"];
  message: string;
  createdAt: Date;
}

export function customerVisibleMessages(messages: readonly AgentMessage[]): CustomerMessageView[] {
  return messages
    .filter((m) => !m.isInternalNote)
    .map((m) => ({ id: m.id, role: m.role, message: m.message, createdAt: m.createdAt }));
}
