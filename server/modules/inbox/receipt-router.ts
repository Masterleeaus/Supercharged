/**
 * Optional callback router, never mounted by default. A trusted integration mapping
 * supplies company and secret; neither is accepted from the request body or headers.
 * Deploy only with a gateway that implements this exact HMAC contract.
 */
import {Router,raw,type RequestHandler} from 'express';
import {InvalidProviderSignature} from './provider-signature.ts';
import type {createReceiptService} from './receipt-service.ts';
export function createReceiptRouter(deps:{
 service:ReturnType<typeof createReceiptService>;
 requireConfiguredProvider:RequestHandler;
}){
 if(!deps||!deps.service||typeof deps.service.receive!=='function'||
   typeof deps.requireConfiguredProvider!=='function')throw Error('receipt: verified service and provider guard required');
 const router=Router();
 router.post('/:integrationId',deps.requireConfiguredProvider,
  raw({type:'application/json',limit:'64kb'}),async(req,res)=>{
   try{
    if(!Buffer.isBuffer(req.body)){res.status(415).json({error:'raw_json_required'});return;}
    const result=await deps.service.receive({
     integrationId:req.params.integrationId,timestamp:req.header('x-inbox-timestamp'),
     signature:req.header('x-inbox-signature'),rawBody:req.body});
    if(result==='unmatched'){res.status(202).json({status:'unmatched'});return;}
    res.status(200).json({status:result});
   }catch(err){
    if(err instanceof InvalidProviderSignature||err instanceof Error&&/^(receipt: invalid integration id|receipt: unknown integration)/.test(err.message)){
     res.status(401).json({error:'unauthorized_callback'});return;
    }
    if(err instanceof Error&&err.message.startsWith('receipt: invalid')){
     res.status(400).json({error:'invalid_callback'});return;
    }
    res.status(503).json({error:'callback_unavailable'});
   }
  });
 return router;
}
