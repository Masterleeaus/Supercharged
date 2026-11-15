/**
 * Channel senders that wrap the existing provider adapters in server/modules/comms. Each one is built from an
 * adapter the caller already configured. Nothing here reads environment variables or secrets.
 */
import {createHash} from 'node:crypto';
import type {EmailSenderWithAudit} from '../comms/email-provider-adapter.ts';
import type {SmsProviderAdapter} from '../comms/sms-provider-adapter.ts';
import type {WhatsAppProviderAdapter} from '../comms/whatsapp-provider-adapter.ts';
import type {Contact,QuietHours} from '../comms/consent.ts';
import {OutboxSendError} from './outbox-types.ts';
import {failureFromAdapterReason,type ChannelSender} from './outbound-transport.ts';

const sha256Hex=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');

export interface EmailOutboundOptions {
 /** Declares whether the mail provider honours the idempotency key. False disables retries after a provider call. */
 idempotent:boolean;
 /** Returns the company's email adapter. One adapter serves one company. */
 adapterFor:(companyId:string)=>EmailSenderWithAudit|Promise<EmailSenderWithAudit>;
 /** Domain for the deterministic Message-ID header. */
 messageIdDomain?:string;
}

export function createEmailOutboundSender(options:EmailOutboundOptions):ChannelSender{
 const domain=options.messageIdDomain??'inbox.invalid';
 return{
  idempotent:options.idempotent===true,
  async send(request){
   const adapter=await options.adapterFor(request.companyId);
   // Same key gives the same Message-ID, so a receiving mailbox can recognise a repeated attempt.
   const messageId=`<${sha256Hex(request.idempotencyKey)}@${domain}>`;
   const result=await adapter({
    to:request.recipient,
    subject:request.subject??'',
    text:request.body,
    headers:{'Message-ID':messageId},
   });
   if(!result||typeof result!=='object')throw new OutboxSendError('provider_error',options.idempotent===true);
   if(result.success!==true){
    // The error text may contain an address, so only a fixed code is kept.
    throw new OutboxSendError('email_send_failed',options.idempotent===true);
   }
   const providerId=typeof result.messageId==='string'&&result.messageId.trim()?result.messageId.trim():messageId;
   return{providerId};
  }
 };
}

export interface SmsOutboundOptions {
 /** Declares whether the SMS provider honours the idempotency key. The Plivo adapter does not, so use false. */
 idempotent:boolean;
 adapter:SmsProviderAdapter;
}

export function createSmsOutboundSender(options:SmsOutboundOptions):ChannelSender{
 return{
  idempotent:options.idempotent===true,
  async send(request){
   const result=await options.adapter.send({companyId:request.companyId,to:request.recipient,body:request.body});
   if(result.ok===true&&typeof result.externalId==='string'&&result.externalId.trim())
    return{providerId:result.externalId.trim()};
   throw failureFromAdapterReason(result.ok===false?String(result.reason):'provider_error',options.idempotent===true);
  }
 };
}

export interface WhatsAppOutboundContext {
 contact:Contact|null|undefined;
 lastInboundAt:Date|number|null|undefined;
 quietHours?:QuietHours|null;
}

export interface WhatsAppOutboundOptions {
 idempotent:boolean;
 adapter:WhatsAppProviderAdapter;
 /** Loads the recipient's contact and 24-hour session window. Return null when the contact is unknown. */
 resolveContext:(companyId:string,recipient:string)=>WhatsAppOutboundContext|null|Promise<WhatsAppOutboundContext|null>;
}

export function createWhatsAppOutboundSender(options:WhatsAppOutboundOptions):ChannelSender{
 return{
  idempotent:options.idempotent===true,
  async send(request){
   const context=await options.resolveContext(request.companyId,request.recipient);
   if(!context)throw new OutboxSendError('invalid_contact',false);
   const result=await options.adapter.send({
    to:request.recipient,
    contact:context.contact,
    purpose:'transactional',
    now:new Date(),
    lastInboundAt:context.lastInboundAt,
    text:request.body,
    quietHours:context.quietHours??null,
   });
   if(result.ok===true&&typeof result.externalId==='string'&&result.externalId.trim())
    return{providerId:result.externalId.trim()};
   throw failureFromAdapterReason(result.ok===false?String(result.reason):'provider_error',options.idempotent===true);
  }
 };
}
