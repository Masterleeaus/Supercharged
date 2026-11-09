/** Signature is verified before JSON parsing or any database access. */
import {verifyProviderSignature} from './provider-signature.ts';
import {parseDeliveryReceipt} from './delivery-receipt.ts';
import type {ReceiptRepository} from './sql-delivery-receipts.ts';
export interface ProviderBinding {companyId:string;provider:string;secret:string;}
export interface ProviderBindingResolver {resolve(integrationId:string):Promise<ProviderBinding|null>;}
export function createReceiptService(resolver:ProviderBindingResolver,repository:ReceiptRepository){
 if(!resolver||typeof resolver.resolve!=='function')throw Error('receipt: trusted integration resolver required');
 if(!repository||typeof repository.record!=='function')throw Error('receipt: durable repository required');
 return{
  async receive(input:{integrationId:string;timestamp:unknown;signature:unknown;rawBody:Buffer;now?:number}){
   if(typeof input.integrationId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.integrationId))
    throw Error('receipt: invalid integration id');
   const binding=await resolver.resolve(input.integrationId);
   if(!binding)throw Error('receipt: unknown integration');
   verifyProviderSignature({rawBody:input.rawBody,timestamp:input.timestamp,
    signature:input.signature,secret:binding.secret,now:input.now});
   const receipt=parseDeliveryReceipt(binding.companyId,binding.provider,input.rawBody);
   return repository.record(receipt);
  }
 };
}
