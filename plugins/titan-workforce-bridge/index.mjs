/** AgentLabs-native optional Workforce entry point; no alternate agent engine. */
import {registerWorkforcePreviewRoutes} from '../../server/integrations/titan-workforce/route.mjs';
import {registerLeadPreviewRoute} from '../../server/integrations/titan-workforce/lead-review.mjs';

// Runs each middleware in order; a middleware that calls next(err) stops the chain.
function sequence(fns){
  return (req,res,next)=>{
    const step=(i,err)=>{
      if(err||i===fns.length)return next(err);
      return fns[i](req,res,(e)=>step(i+1,e));
    };
    step(0);
  };
}

export function registerPlugin(app, options={}){
  // D2: preview routes need a named permission. Team membership alone is not a gate, and the generic
  // adminAuthMiddleware option is deliberately ignored here. No gate supplied means no routes.
  const gates=[].concat(options.workforceAdminMiddleware??[]);
  const gateReady=gates.length>0&&gates.every(g=>typeof g==='function');
  const config={
    adminAuthMiddleware:gateReady?sequence(gates):undefined,
    // Ports must come from the trusted identity/authority integration owner.
    ports:options.titanWorkforcePorts,
    mode:process.env.TITAN_WORKFORCE_ADAPTER_MODE
  };
  const workforce=registerWorkforcePreviewRoutes(app,config);
  const revenue=registerLeadPreviewRoute(app,config);
  return Object.freeze({registered:workforce.registered||revenue.registered,
    workforce,revenue});
}
