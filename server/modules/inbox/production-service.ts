/**
 * Opt-in, verified durable Inbox service constructor.
 * This deliberately does not mount routes or provide a fake approval gate.
 * Production callers MUST supply a real approval port and an atomic runner.
 */
import {createInboxService,type InboxService} from './inbox-service.ts';
import {createSqlInboxStore} from './sql-store.ts';
import {requireInboxSchema,type InboxSchemaProbe} from './schema-readiness.ts';
import type {ApprovalPort} from './ports.ts';
import {inboxTransactionsFor} from './sql-transaction-runner.ts';
import type {TenantPool} from '../../infrastructure/database/tenant-context.ts';
export interface VerifiedInboxDependencies {
 pool:TenantPool; schemaProbe:InboxSchemaProbe;
 approvals:ApprovalPort;
}
export async function createVerifiedInboxService(deps:VerifiedInboxDependencies):Promise<InboxService>{
 if(!deps||!deps.pool||typeof deps.pool.connect!=='function')throw Error('inbox: durable PostgreSQL pool required');
 if(!deps.approvals||typeof deps.approvals.gateAction!=='function'||
    typeof deps.approvals.getApproval!=='function'||typeof deps.approvals.markExecuted!=='function')
    throw Error('inbox: complete durable approval port required');
 await requireInboxSchema(deps.schemaProbe);
 return createInboxService({store:createSqlInboxStore(deps.pool),approvals:deps.approvals,transactionsFor:inboxTransactionsFor(deps.pool)});
}
