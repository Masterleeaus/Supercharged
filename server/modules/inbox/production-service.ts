/**
 * Opt-in, verified durable Inbox service constructor.
 * This deliberately does not mount routes or provide a fake approval gate.
 * Production callers MUST supply a real approval port and an atomic runner.
 */
import {createInboxService,type InboxService} from './inbox-service.ts';
import {createSqlInboxStore} from './sql-store.ts';
import {requireInboxSchema,type InboxSchemaProbe} from './schema-readiness.ts';
import type {ApprovalPort} from './ports.ts';
import type {PreSendGate} from '../comms/presend-gate.ts';
import {createInboxApprovalPort,type CanonicalApprovalPortSource} from './approval-port.ts';
import {inboxTransactionsFor} from './sql-transaction-runner.ts';
import type {TenantPool} from '../../infrastructure/database/tenant-context.ts';
export interface VerifiedInboxDependencies {
 pool:TenantPool; schemaProbe:InboxSchemaProbe;
 /** Required. Pre-send compliance gate: suppression, consent, opt-out and quiet hours. */
 compliance:PreSendGate;
 approvals?:ApprovalPort;
 /** Canonical ApprovalService is preferred for production policy, reads and post-commit audit. */
 approvalService?:CanonicalApprovalPortSource;
}
export async function createVerifiedInboxService(deps:VerifiedInboxDependencies):Promise<InboxService>{
 if(!deps||!deps.pool||typeof deps.pool.connect!=='function')throw Error('inbox: durable PostgreSQL pool required');
 if(deps.approvals&&deps.approvalService)throw Error('inbox: supply one approval integration only');
 const approvals=deps.approvalService?createInboxApprovalPort(deps.approvalService):deps.approvals;
 if(!approvals||typeof approvals.gateAction!=='function'||
    typeof approvals.getApproval!=='function'||typeof approvals.markExecuted!=='function')
    throw Error('inbox: complete durable approval port required');
 if(!deps.compliance||typeof deps.compliance.check!=='function')throw Error('inbox: pre-send compliance gate required');
 await requireInboxSchema(deps.schemaProbe);
 return createInboxService({store:createSqlInboxStore(deps.pool),approvals,compliance:deps.compliance,transactionsFor:inboxTransactionsFor(deps.pool)});
}
