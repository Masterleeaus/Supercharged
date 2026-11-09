/**
 * Scoped approval + Inbox write transaction.
 * Creates one runner per authenticated company; no shared mutable tenant state.
 * Uses the existing conditional approval claim and row-update implementation.
 */
import {withTenant,assertCompanyId,type TenantPool} from '../../infrastructure/database/tenant-context.ts';
import {sqlInboxWriteTx} from './drizzle-adapter.ts';
import type {InboxTransactionRunner} from './ports.ts';
export function createInboxSqlTransactionRunner(pool:TenantPool,companyId:string):InboxTransactionRunner{
 if(!pool||typeof pool.connect!=='function')throw Error('inbox: SQL transaction runner requires a PostgreSQL pool');
 const company=assertCompanyId(companyId);
 return {
  runInTransaction<T>(fn:(tx:import('./ports.ts').InboxWriteTx)=>Promise<T>):Promise<T>{
   if(typeof fn!=='function')return Promise.reject(Error('inbox: transaction callback required'));
   return withTenant(pool,company,db=>fn(sqlInboxWriteTx(db,company)));
  },
 };
}
export function inboxTransactionsFor(pool:TenantPool): (companyId:string)=>InboxTransactionRunner {
 if(!pool||typeof pool.connect!=='function')throw Error('inbox: PostgreSQL pool required for tenant transactions');
 return (companyId:string)=>createInboxSqlTransactionRunner(pool,companyId);
}
