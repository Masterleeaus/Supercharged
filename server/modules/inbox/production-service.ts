/**
 * Opt-in, verified durable Inbox service constructor.
 * This deliberately does not mount routes or provide a fake approval gate.
 * Production callers MUST supply a real approval port and an atomic runner.
 */
import {createInboxService,type InboxService} from './inbox-service.ts';
import type {SuppressionList} from '../comms/suppression.ts';
import type {OptOutReplySender} from './inbound-optout.ts';
import {createSqlInboxStore} from './sql-store.ts';
import {requireInboxSchema,type InboxSchemaProbe} from './schema-readiness.ts';
import type {ApprovalPort} from './ports.ts';
import {createInboxApprovalPort,type CanonicalApprovalPortSource} from './approval-port.ts';
import {inboxTransactionsFor} from './sql-transaction-runner.ts';
import type {TenantPool} from '../../infrastructure/database/tenant-context.ts';
export interface VerifiedInboxDependencies {
 pool:TenantPool; schemaProbe:InboxSchemaProbe;
 approvals?:ApprovalPort;
 /** Canonical ApprovalService is preferred for production policy, reads and post-commit audit. */
 approvalService?:CanonicalApprovalPortSource;
 /** Durable suppression list. Inbound STOP and START are recorded here and sends check it. Required. */
 suppression:SuppressionList;
 /** Sends the required STOP and START confirmation. Required. */
 optOutReply:OptOutReplySender;
}
export async function createVerifiedInboxService(deps:VerifiedInboxDependencies):Promise<InboxService>{
 if(!deps||!deps.pool||typeof deps.pool.connect!=='function')throw Error('inbox: durable PostgreSQL pool required');
 if(deps.approvals&&deps.approvalService)throw Error('inbox: supply one approval integration only');
 const approvals=deps.approvalService?createInboxApprovalPort(deps.approvalService):deps.approvals;
 if(!approvals||typeof approvals.gateAction!=='function'||
    typeof approvals.getApproval!=='function'||typeof approvals.markExecuted!=='function')
    throw Error('inbox: complete durable approval port required');
 if(!deps.suppression||typeof deps.suppression.isSuppressed!=='function')throw Error('inbox: suppression list required');
 if(typeof deps.optOutReply!=='function')throw Error('inbox: opt-out reply sender required');
 await requireInboxSchema(deps.schemaProbe);
 return createInboxService({store:createSqlInboxStore(deps.pool),approvals,transactionsFor:inboxTransactionsFor(deps.pool),suppression:deps.suppression,optOutReply:deps.optOutReply});
}
