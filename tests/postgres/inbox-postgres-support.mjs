import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createSqlInboxStore} from '../../server/modules/inbox/sql-store.ts';
import {verifyInboxSchema} from '../../server/modules/inbox/schema-readiness.ts';
import {createSqlOutbox} from '../../server/modules/inbox/sql-outbox.ts';
// Node runs test files in separate processes. Give each file its own tenants so
// bulk enqueue/claim operations cannot consume another file's test messages.
export const A=randomUUID(),B=randomUUID();
export const NOW=new Date('2026-11-09T00:00:00Z');
export const enabled=process.env.INBOX_PG_DISPOSABLE==='true'&&Boolean(process.env.INBOX_PG_INTEGRATION_URL);
export const id=prefix=>prefix+'-'+randomUUID();
export function fixture(){if(!enabled)throw Error('Disposable Inbox PostgreSQL fixture required');const pool=new pg.Pool({connectionString:process.env.INBOX_PG_INTEGRATION_URL,max:4});return{pool,store:createSqlInboxStore(pool),outbox:createSqlOutbox(pool),checkReadiness:()=>verifyInboxSchema(pool),close:()=>pool.end()};}
export function participant(companyId,idValue){return{companyId,id:idValue,kind:'contact',channel:'email',address:idValue+'@example.test',displayName:'Sender',createdAt:NOW};}
export function thread(companyId,idValue){return{companyId,id:idValue,channel:'email',subject:'Inbox test',status:'open',assignee:null,lastMessageAt:NOW,createdAt:NOW,updatedAt:NOW};}
export function message(companyId,idValue,threadId,externalId){return{companyId,id:idValue,threadId,direction:'inbound',channel:'email',status:'received',authorKind:'contact',authorId:null,body:'Hello',bodySha256:'a'.repeat(64),externalId,approvalId:null,createdAt:NOW,updatedAt:NOW,queuedAt:null};}
