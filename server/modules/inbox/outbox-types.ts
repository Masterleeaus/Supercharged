import type {Channel} from './types.ts';
export type OutboxStatus='queued'|'leased'|'retry'|'sent'|'dead';
export interface OutboxJob {
 id:string; companyId:string;messageId:string;channel:Channel;status:OutboxStatus;
 attempts:number;nextAttemptAt:Date;leasedUntil:Date|null;leaseToken:string|null;
 providerId:string|null;lastError:string|null;
}
/** What a worker needs to send one queued Inbox message. Null recipient means no contact is on the thread. */
export interface OutboxDelivery {
 body:string;
 recipient:string|null;
 subject:string|null;
}
export interface OutboxTransportJob {
 companyId:string;messageId:string;channel:Channel;body:string;
 recipient:string|null;subject:string|null;idempotencyKey:string;
}
/**
 * Error from a send attempt. `code` is a fixed reason string that never carries provider text or addresses.
 * `retryable:false` means a retry could duplicate the message or can never succeed, so the job is dead-lettered now.
 */
export class OutboxSendError extends Error {
 readonly code:string;
 readonly retryable:boolean;
 constructor(code:string,retryable:boolean){
  super(code);
  this.name='OutboxSendError';
  this.code=code;
  this.retryable=retryable;
 }
}
export interface OutboxTransport {
 /** The provider adapter MUST honor idempotencyKey on repeated attempts, or throw OutboxSendError with retryable:false. */
 send(job:OutboxTransportJob):Promise<{providerId:string}>;
}
export interface OutboxRepository {
 enqueueQueued(companyId:string,limit:number):Promise<number>;
 claim(companyId:string,limit:number,leaseSeconds:number):Promise<OutboxJob[]>;
 /** Null when the message is no longer an outbound queued message for this company. */
 loadDelivery(companyId:string,messageId:string):Promise<OutboxDelivery|null>;
 markSent(companyId:string,id:string,leaseToken:string,providerId:string):Promise<boolean>;
 markRetry(companyId:string,id:string,leaseToken:string,delaySeconds:number,errorCode:string,dead:boolean):Promise<boolean>;
}
