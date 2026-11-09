/**
 * PostgreSQL-backed InboxStore for the existing numbered 0010a schema.
 * Uses tenant transactions, company predicates and the existing advisory-lock
 * client so inbound deduplication survives concurrent workers without pool exhaustion.
 * Production activation still requires reviewed RLS for all five Inbox tables.
 */
import { assertCompanyId,withTenant,type TenantPool,type TenantQueryClient } from '../../infrastructure/database/tenant-context.ts';
import { inboundAdvisoryKey, currentInboundLockClient, sqlInboxWriteTx } from './drizzle-adapter.ts';
import type { InboxStore, ThreadFilter, ThreadPatch, MessagePatch } from './ports.ts';
import type { Participant, Thread, ThreadParticipant, Message, Channel } from './types.ts';
import { PARTICIPANT_COLUMNS,THREAD_COLUMNS,MESSAGE_COLUMNS,fromParticipant,fromThread,fromLink,fromMessage } from './sql-rows.ts';
export function createSqlInboxStore(pool:TenantPool):InboxStore {
 if(!pool||typeof pool.connect!=='function')throw new Error('inbox: PostgreSQL pool required');
 const scoped=<T>(companyId:string,fn:(client:TenantQueryClient)=>Promise<T>):Promise<T>=>{
  const co=assertCompanyId(companyId);
  const locked=currentInboundLockClient();
  // A lock transaction can only be reused for its own tenant. Check the
  // transaction-local setting instead of trusting the ambient JS context.
  if(locked)return locked.query("SELECT current_setting('app.company_id',true) AS tenant").then(x=>{
   if(x.rows[0]?.tenant!==co)throw new Error('inbox: inbound lock belongs to another company');
   return fn(locked);
  });
  return withTenant(pool,co,fn);
 };
 const first=<T>(rows:any[],fn:(row:any)=>T):T|null=>rows[0]?fn(rows[0]):null;
 return {
  async lockInboundKey<T>(companyId:string,channel:Channel,address:string,fn:()=>Promise<T>):Promise<T>{
   const co=assertCompanyId(companyId);
   const {runInboundLocked}=await import('./sql-lock.ts');
   return runInboundLocked(pool,co,channel,address,fn);
  },
  insertParticipant(p:Participant){return scoped(p.companyId,async db=>{await db.query(
   'INSERT INTO inbox_participants (id,company_id,kind,channel,address,display_name,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
   [p.id,p.companyId,p.kind,p.channel,p.address,p.displayName,p.createdAt]);});},
  findContactParticipant(companyId:string,channel:Channel,address:string){
   return scoped(companyId,async db=>first((await db.query(
    `SELECT ${PARTICIPANT_COLUMNS} FROM inbox_participants WHERE company_id=$1 AND kind='contact' AND channel=$2 AND address=$3`,
    [companyId,channel,address])).rows,fromParticipant));},
  insertThread(t:Thread){return scoped(t.companyId,async db=>{await db.query(
   'INSERT INTO inbox_threads (id,company_id,channel,subject,status,assignee_kind,assignee_id,last_message_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [t.id,t.companyId,t.channel,t.subject,t.status,t.assignee?.kind??null,t.assignee?.id??null,t.lastMessageAt,t.createdAt,t.updatedAt]);});},
  findThread(companyId:string,id:string){return scoped(companyId,async db=>first((await db.query(
   `SELECT ${THREAD_COLUMNS} FROM inbox_threads WHERE company_id=$1 AND id=$2`,[companyId,id])).rows,fromThread));},
  findOpenThreadForParticipant(companyId:string,channel:Channel,participantId:string){
   return scoped(companyId,async db=>first((await db.query(
    `SELECT ${THREAD_COLUMNS} FROM inbox_threads t WHERE t.company_id=$1 AND t.channel=$2 AND t.status <> 'closed'
       AND EXISTS(SELECT 1 FROM inbox_thread_participants p WHERE p.company_id=t.company_id AND p.thread_id=t.id AND p.participant_id=$3)
       ORDER BY t.updated_at DESC,t.id ASC LIMIT 1`,[companyId,channel,participantId])).rows,fromThread));},
  updateThread(companyId:string,id:string,patch:ThreadPatch){
   return scoped(companyId,async db=>sqlInboxWriteTx(db,companyId).updateThread(companyId,id,patch));},
  listThreads(companyId:string,filter:ThreadFilter){
   return scoped(companyId,async db=>{
    const args:unknown[]=[companyId];let where='company_id=$1';
    if(filter?.status!==undefined){args.push(filter.status);where+=` AND status=$${args.length}`;}
    if(filter?.assigneeId!==undefined){args.push(filter.assigneeId);where+=` AND assignee_id=$${args.length}`;}
    return (await db.query(`SELECT ${THREAD_COLUMNS} FROM inbox_threads WHERE ${where} ORDER BY updated_at DESC,id ASC`,args)).rows.map(fromThread);
   });},
  linkParticipant(link:ThreadParticipant){return scoped(link.companyId,async db=>{await db.query(
   'INSERT INTO inbox_thread_participants (company_id,thread_id,participant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
   [link.companyId,link.threadId,link.participantId]);});},
  listThreadParticipants(companyId:string,threadId:string){return scoped(companyId,async db=>
   (await db.query('SELECT company_id,thread_id,participant_id FROM inbox_thread_participants WHERE company_id=$1 AND thread_id=$2 ORDER BY participant_id',[companyId,threadId])).rows.map(fromLink));},
  insertMessage(m:Message){return scoped(m.companyId,async db=>{await db.query(
   'INSERT INTO inbox_messages (id,company_id,thread_id,direction,channel,status,author_kind,author_id,body,body_sha256,external_id,approval_id,created_at,updated_at,queued_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
   [m.id,m.companyId,m.threadId,m.direction,m.channel,m.status,m.authorKind,m.authorId,m.body,m.bodySha256,m.externalId,m.approvalId,m.createdAt,m.updatedAt,m.queuedAt]);});},
  findMessage(companyId:string,id:string){return scoped(companyId,async db=>first((await db.query(
   `SELECT ${MESSAGE_COLUMNS} FROM inbox_messages WHERE company_id=$1 AND id=$2`,[companyId,id])).rows,fromMessage));},
  findMessageByExternalId(companyId:string,channel:Channel,externalId:string){return scoped(companyId,async db=>first((await db.query(
   `SELECT ${MESSAGE_COLUMNS} FROM inbox_messages WHERE company_id=$1 AND channel=$2 AND external_id=$3`,[companyId,channel,externalId])).rows,fromMessage));},
  updateMessage(companyId:string,id:string,patch:MessagePatch){return scoped(companyId,async db=>sqlInboxWriteTx(db,companyId).updateMessage(companyId,id,patch));},
  listMessages(companyId:string,threadId:string){return scoped(companyId,async db=>
   (await db.query(`SELECT ${MESSAGE_COLUMNS} FROM inbox_messages WHERE company_id=$1 AND thread_id=$2 ORDER BY created_at ASC,id ASC`,[companyId,threadId])).rows.map(fromMessage));},
 };
}
