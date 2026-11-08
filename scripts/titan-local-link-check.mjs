/** Safe operator preflight: Desk -> local Field, read-only and signed; no secrets printed. */
import {probeLocalPeer} from '../server/integrations/titan-field/local-link-probe.mjs';
if(process.env.TITAN_LOCAL_LINK_ENABLED!=='1'){
  console.error('Titan local link disabled. No check performed.');process.exitCode=2;
}else{
  try{
    const result=await probeLocalPeer('titan-field',{
      origin:process.env.TITAN_LOCAL_FIELD_ORIGIN||undefined});
    console.log(JSON.stringify({application:'titan-desk',peer:result.service,
      reachable:result.reachable,capabilities:result.capabilities,
      execution_enabled:false},null,2));
  }catch(error){
    console.error(JSON.stringify({application:'titan-desk',peer:'titan-field',
      reachable:false,error:error?.code||'local_link_unavailable'}));process.exitCode=1;
  }
}
