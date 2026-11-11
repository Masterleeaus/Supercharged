import type {Channel} from './types.ts';
export type OutboxStatus='queued'|'leased'|'retry'|'sent'|'dead';
export interface OutboxJob {
 id:string; companyId:string;messageId:string;channel:Channel;status:OutboxStatus;
 attempts:number;nextAttemptAt:Date;leasedUntil:Date|null;leaseToken:string|null;
 providerId:string|null;lastError:string|null;
}
export interface OutboxTransport {
 /** The provider adapter MUST honor idempotencyKey on repeated attempts. */
 send(job:{companyId:string;messageId:string;channel:Channel;body:string;idempotencyKey:string}):Promise<{providerId:string}>;
}
export interface OutboxRepository {
 enqueueQueued(companyId:string,limit:number):Promise<number>;
 claim(companyId:string,limit:number,leaseSeconds:number):Promise<OutboxJob[]>;
 loadBody(companyId:string,messageId:string):Promise<string|null>;
 markSent(companyId:string,id:string,leaseToken:string,providerId:string):Promise<boolean>;
 markRetry(companyId:string,id:string,leaseToken:string,delaySeconds:number,errorCode:string,dead:boolean):Promise<boolean>;
}
