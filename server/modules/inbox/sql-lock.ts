/** Locks one inbound contact across workers while binding every operation to one tenant transaction. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertCompanyId,withTenant,type TenantPool,type TenantQueryClient } from '../../infrastructure/database/tenant-context.ts';
import { inboundAdvisoryKey } from './drizzle-adapter.ts';
import type { Channel } from './types.ts';
// Separate from the legacy placeholder lock context: the SQL store reads this context.
const current=new AsyncLocalStorage<TenantQueryClient>();
export function lockedInboxClient():TenantQueryClient|undefined{return current.getStore();}
export async function runInboundLocked<T>(pool:TenantPool,companyId:string,channel:Channel,address:string,fn:()=>Promise<T>):Promise<T> {
 const co=assertCompanyId(companyId);
 // Uses a transaction-local advisory lock, not a session-global lock.
 // All nested CRUD on this async context reuses the pinned client.
 return withTenant(pool,co,async db=>{
  await db.query('SELECT pg_advisory_xact_lock($1::bigint)',[inboundAdvisoryKey(co,channel,address)]);
  return current.run(db,fn);
 });
}
