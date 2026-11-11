/** Explicit PostgreSQL mappings for the already-numbered Inbox tables. */
import type { Participant, Thread, ThreadParticipant, Message } from './types.ts';
type Row=Record<string,any>;
export const PARTICIPANT_COLUMNS='id, company_id, kind, channel, address, display_name, created_at';
export const THREAD_COLUMNS='id, company_id, channel, subject, status, assignee_kind, assignee_id, last_message_at, created_at, updated_at';
export const MESSAGE_COLUMNS='id, company_id, thread_id, direction, channel, status, author_kind, author_id, body, body_sha256, external_id, approval_id, created_at, updated_at, queued_at';
const date=(v:unknown)=>v instanceof Date?v:new Date(String(v));
const opt=(v:unknown)=>v==null?null:date(v);
export function fromParticipant(r:Row):Participant{return {id:r.id,companyId:r.company_id,kind:r.kind,channel:r.channel??null,address:r.address??null,displayName:r.display_name??null,createdAt:date(r.created_at)};}
export function fromThread(r:Row):Thread{return{id:r.id,companyId:r.company_id,channel:r.channel,subject:r.subject??null,status:r.status,assignee:r.assignee_kind?{kind:r.assignee_kind,id:r.assignee_id}:null,lastMessageAt:opt(r.last_message_at),createdAt:date(r.created_at),updatedAt:date(r.updated_at)};}
export function fromLink(r:Row):ThreadParticipant{return{companyId:r.company_id,threadId:r.thread_id,participantId:r.participant_id};}
export function fromMessage(r:Row):Message{return{id:r.id,companyId:r.company_id,threadId:r.thread_id,direction:r.direction,channel:r.channel,status:r.status,authorKind:r.author_kind,authorId:r.author_id??null,body:r.body,bodySha256:r.body_sha256,externalId:r.external_id??null,approvalId:r.approval_id??null,createdAt:date(r.created_at),updatedAt:date(r.updated_at),queuedAt:opt(r.queued_at)};}
