/** Plugin-native HTTP adapter. Admin authentication is supplied by AgentLabs. */
import {previewWorkforceAction} from './proposal.mjs';
import {previewWorkforceBatch} from './batch.mjs';
import {WorkforceAdapterError} from './validation.mjs';
function errorResponse(e){
  return e instanceof WorkforceAdapterError?{status:e.status,body:{error:e.code}}:
    {status:503,body:{error:'workforce_adapter_unavailable'}};
}
/** ports injected by DB/identity integration owner; never use request.body for identity. */
export function registerWorkforcePreviewRoutes(app,{adminAuthMiddleware,ports,mode}={}){
  if(mode!=='shadow')return Object.freeze({registered:false,reason:'disabled'});
  if(typeof adminAuthMiddleware!=='function')return Object.freeze({registered:false,reason:'admin_auth_missing'});
  const path='/api/titan-workforce/v1/previews';
  app.post(path,adminAuthMiddleware,async(req,res)=>{
    res.set('cache-control','no-store');
    if(!Buffer.isBuffer(req.rawBody)||req.rawBody.byteLength>2048)
      return res.status(413).json({error:'invalid_raw_body'});
    try{
      const proposal=await previewWorkforceAction(req.body,req,{ports});
      return res.status(202).json(proposal);
    }catch(e){const result=errorResponse(e);return res.status(result.status).json(result.body);}
  });
  app.post(`${path}/batch`,adminAuthMiddleware,async(req,res)=>{
    res.set('cache-control','no-store');
    if(!Buffer.isBuffer(req.rawBody)||req.rawBody.byteLength>16384)
      return res.status(413).json({error:'invalid_raw_body'});
    try{
      const result=await previewWorkforceBatch(req.body?.requests,req,{ports});
      return res.status(202).json(result);
    }catch(e){const result=errorResponse(e);return res.status(result.status).json(result.body);}
  });
  return Object.freeze({registered:true,mode:'shadow',paths:[path,`${path}/batch`]});
}
