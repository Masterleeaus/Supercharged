/** Public delivery state is projected from signed immutable provider receipts. */
import {assertCompanyId} from '../../infrastructure/database/tenant-context.ts';
export type DeliveryOutcome='delivered'|'failed';
export interface DeliveryState {
 companyId:string;outboxId:string;messageId:string;
 outcome:DeliveryOutcome;eventId:string;providerEventAt:Date|null;updatedAt:Date;
}
export function mapDeliveryState(row:Record<string,any>):DeliveryState{
 return{companyId:assertCompanyId(row.company_id),outboxId:row.outbox_id,
  messageId:row.message_id,outcome:row.outcome,eventId:row.event_id,
  providerEventAt:row.provider_event_at?new Date(row.provider_event_at):null,
  updatedAt:new Date(row.updated_at)};
}
export function validateDeliveryOutcome(value:unknown):asserts value is DeliveryOutcome{
 if(value!=='delivered'&&value!=='failed')throw Error('delivery: invalid outcome');
}
