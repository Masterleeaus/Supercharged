/*
 * Inbox types. Omnichannel thread model: a thread belongs to one channel, links
 * one or more participants, carries messages in both directions, and is assigned
 * to a human or an agent. Every entity carries company_id. Types and constants
 * only, no runtime imports.
 */

export const CHANNELS = ['email', 'sms', 'whatsapp', 'web_chat', 'phone'] as const;
export type Channel = (typeof CHANNELS)[number];

export const THREAD_STATUSES = ['open', 'snoozed', 'closed'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** contact: an external person. staff: a human employee. agent: an AI worker. */
export type ParticipantKind = 'contact' | 'staff' | 'agent';

export type AssigneeKind = 'human' | 'agent';

export interface Assignee {
  kind: AssigneeKind;
  id: string;
}

export interface Participant {
  companyId: string;
  id: string;
  kind: ParticipantKind;
  /** Set for contacts (the address on this channel). Null for staff and agents. */
  channel: Channel | null;
  address: string | null;
  displayName: string | null;
  createdAt: Date;
}

export interface ThreadParticipant {
  companyId: string;
  threadId: string;
  participantId: string;
}

export interface Thread {
  companyId: string;
  id: string;
  channel: Channel;
  subject: string | null;
  status: ThreadStatus;
  assignee: Assignee | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageDirection = 'inbound' | 'outbound';

/**
 * received: inbound, stored. draft: outbound, not yet sent. awaiting_approval: an
 * agent asked to send, and the gate has not decided. queued: handed to the
 * transport layer (not in this module). rejected: the gate refused or expired.
 */
export type MessageStatus = 'received' | 'draft' | 'awaiting_approval' | 'queued' | 'rejected';

export type AuthorKind = 'contact' | 'staff' | 'agent';

export interface Message {
  companyId: string;
  id: string;
  threadId: string;
  direction: MessageDirection;
  channel: Channel;
  status: MessageStatus;
  authorKind: AuthorKind;
  authorId: string | null;
  body: string;
  /** Hash of the exact body. The approval is bound to it, so an approved body cannot change. */
  bodySha256: string;
  /** Provider message id for inbound dedupe. Null for outbound. */
  externalId: string | null;
  approvalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  queuedAt: Date | null;
}

/** The verified caller. Comes from the session or agent runtime, never from request input. */
export interface Actor {
  kind: 'human' | 'agent';
  id: string;
}

/** Approval action name for an outbound message. */
export const SEND_ACTION = 'inbox.send_message';

export const MAX_BODY_LENGTH = 10000;
export const MAX_ID_LENGTH = 200;
