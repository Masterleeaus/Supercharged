/**
 * Construct the existing ApprovalService with an injected tenant-scoped pool.
 * Import the database runtime only when Inbox is explicitly enabled.
 * No in-memory policy or approval fallback is permitted.
 */
import {withTenant,type TenantPool} from '../../infrastructure/database/tenant-context.ts';
import type {CanonicalApprovalPortSource} from './approval-port.ts';
export async function createCanonicalInboxApprovalService(pool:TenantPool):Promise<CanonicalApprovalPortSource>{
 if(!pool||typeof pool.connect!=='function')throw Error('inbox: PostgreSQL pool required for approvals');
 const [{ApprovalService},{drizzle}]=await Promise.all([
  import('../approvals/approval-service.ts'),
  import('drizzle-orm/node-postgres'),
 ]);
 const tenant={run:<T>(companyId:string,fn:(db:any)=>Promise<T>):Promise<T>=>
  withTenant(pool,companyId,async client=>fn(drizzle(client as any) as any))};
 return new ApprovalService({tenant});
}
