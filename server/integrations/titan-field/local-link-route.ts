/** Desk-native read-only signed same-host capability endpoint. */
import {Router,type Request,type Response} from 'express';
// @ts-ignore Shared pure ESM link protocol
import {verifyLocalLinkRequest,signLocalLinkResponse} from './local-link-wire.mjs';
// @ts-ignore Pure ESM capability manifest
import {describeDeskLocalCapabilities} from './local-link-capabilities.mjs';
export function createTitanLocalLinkRouter():Router{
  const router=Router();
  router.get('/api/titan-bridge/v1/capabilities',(req:Request,res:Response)=>{
    res.set('cache-control','no-store');
    if(process.env.TITAN_LOCAL_LINK_ENABLED!=='1')return res.status(503).json({error:'local_link_disabled'});
    const path='/api/titan-bridge/v1/capabilities';
    const timestamp=req.header('x-titan-local-timestamp')??'';
    try{
      verifyLocalLinkRequest({secret:process.env.TITAN_LOCAL_LINK_SECRET,path,timestamp,
        signature:req.header('x-titan-local-signature')??''});
      const body=JSON.stringify(describeDeskLocalCapabilities());
      const signature=signLocalLinkResponse({secret:process.env.TITAN_LOCAL_LINK_SECRET,path,timestamp,body});
      return res.status(200).set('x-titan-local-receipt-signature',signature)
        .type('application/json').send(body);
    }catch{return res.status(401).json({error:'local_link_unauthorized'});}
  });
  return router;
}
