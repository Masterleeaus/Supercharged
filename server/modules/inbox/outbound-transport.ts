/**
 * Routes queued Inbox messages to per-channel provider senders. Each sender wraps one existing provider adapter
 * from server/modules/comms. The transport adds no network I/O of its own.
 *
 * Retry rules, so a retry can never send a second copy:
 * - A sender is used only for its own channel. An unconfigured channel fails without any provider call.
 * - A sender that cannot honour the idempotency key (idempotent:false) gets no retry after the provider was reached.
 *   Its failures are dead-lettered for manual review.
 * - A refusal before any provider call (consent, quiet hours, suppression, invalid input) is never retried.
 */
import {OutboxSendError,type OutboxTransport,type OutboxTransportJob} from './outbox-types.ts';
import {CHANNELS,type Channel} from './types.ts';

export interface ChannelSendRequest {
 companyId:string;
 recipient:string;
 subject:string|null;
 body:string;
 idempotencyKey:string;
}

export interface ChannelSender {
 /** True only when the provider honours idempotencyKey on repeated requests. */
 readonly idempotent:boolean;
 /** Resolves with the provider's acknowledgment ID, or throws. Prefer OutboxSendError with a fixed code. */
 send(request:ChannelSendRequest):Promise<{providerId:string}>;
}

export type ChannelSenders=Partial<Record<Channel,ChannelSender>>;

const isChannel=(value:string):value is Channel=>(CHANNELS as readonly string[]).includes(value);

export function createInboxOutboundTransport(senders:ChannelSenders):OutboxTransport{
 if(!senders||typeof senders!=='object')throw Error('inbox outbound: sender map required');
 const table=new Map<Channel,ChannelSender>();
 for(const [channel,sender] of Object.entries(senders)){
  if(!isChannel(channel))throw Error('inbox outbound: unknown channel');
  if(!sender||typeof sender.send!=='function'||typeof sender.idempotent!=='boolean')
   throw Error('inbox outbound: sender must declare idempotent and send()');
  table.set(channel,sender);
 }
 return{
  async send(job:OutboxTransportJob){
   const sender=table.get(job.channel);
   // Not configured is retryable: provider config may be added before the attempt limit is reached.
   if(!sender)throw new OutboxSendError('provider_not_configured',true);
   if(!job.recipient)throw new OutboxSendError('recipient_missing',false);
   if(typeof job.idempotencyKey!=='string'||!job.idempotencyKey)throw new OutboxSendError('idempotency_key_missing',false);
   let response:{providerId:string}|undefined;
   try{
    response=await sender.send({companyId:job.companyId,recipient:job.recipient,subject:job.subject,body:job.body,idempotencyKey:job.idempotencyKey});
   }catch(err){
    if(err instanceof OutboxSendError)throw err;
    // Unknown failure after the provider may have accepted the message: retry only when keys are honoured.
    throw new OutboxSendError('provider_error',sender.idempotent);
   }
   if(!response||typeof response.providerId!=='string'||!response.providerId.trim())
    throw new OutboxSendError('missing_provider_ack',sender.idempotent);
   return{providerId:response.providerId.trim()};
  }
 };
}

/**
 * Maps an existing comms adapter refusal reason to a send outcome. Refusals from the adapters happen before the
 * provider call, so they are not retried. 'provider_error' means the provider was reached: retry only if idempotent.
 * 'audit_unavailable' means the adapter stopped before the request, so a retry is safe.
 */
export function failureFromAdapterReason(reason:string,idempotent:boolean):OutboxSendError{
 const safe=/^[a-z_]{1,64}$/.test(reason)?reason:'provider_error';
 if(reason==='audit_unavailable')return new OutboxSendError(safe,true);
 if(reason==='provider_error')return new OutboxSendError(safe,idempotent);
 return new OutboxSendError(safe,false);
}
