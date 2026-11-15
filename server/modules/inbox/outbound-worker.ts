/**
 * Inbox outbound worker. Each tick enqueues queued outbound Inbox messages for each company, then drains the
 * company's due outbox jobs through the dispatcher. Claims use row locks and lease tokens, so several processes
 * can run the worker without sending a message twice.
 *
 * The worker starts only when COMMS_INBOX_OUTBOUND_ENABLED=true and COMMS_INBOX_ENABLED=true. Nothing starts it by
 * default. The caller supplies listCompanyIds, which must return only companies the worker is allowed to serve.
 */
import {createOutboxDispatcher} from './outbox-dispatcher.ts';
import type {OutboxRepository,OutboxTransport} from './outbox-types.ts';

export interface InboxOutboundWorkerDeps {
 repo:OutboxRepository;
 transport:OutboxTransport;
 listCompanyIds:()=>Promise<string[]>;
 enqueueLimit?:number;
 batchSize?:number;
}

export interface InboxOutboundTickResult {
 skipped:boolean;
 companies:number;
 enqueued:number;
 sent:number;
 retried:number;
 dead:number;
 companyErrors:number;
}

export interface InboxOutboundWorker {
 tick():Promise<InboxOutboundTickResult>;
 /** Starts a timer that calls tick(). Returns stop(). The timer is unref'd so it never keeps the process alive. */
 start(intervalMs:number):()=>void;
}

/** True only when both flags are the exact string 'true'. Any other value keeps the outbound path off. */
export function inboxOutboundEnabled(env:Record<string,string|undefined>):boolean{
 return env.COMMS_INBOX_ENABLED==='true'&&env.COMMS_INBOX_OUTBOUND_ENABLED==='true';
}

export function createInboxOutboundWorker(deps:InboxOutboundWorkerDeps):InboxOutboundWorker{
 if(!deps||typeof deps.listCompanyIds!=='function')throw Error('inbox outbound worker: listCompanyIds required');
 const dispatcher=createOutboxDispatcher(deps.repo,deps.transport);
 const enqueueLimit=deps.enqueueLimit??100,batchSize=deps.batchSize??10;
 let running=false;

 async function tick():Promise<InboxOutboundTickResult>{
  const result:InboxOutboundTickResult={skipped:false,companies:0,enqueued:0,sent:0,retried:0,dead:0,companyErrors:0};
  if(running){result.skipped=true;return result;}
  running=true;
  try{
   const ids=await deps.listCompanyIds();
   for(const companyId of ids){
    result.companies++;
    try{
     result.enqueued+=await deps.repo.enqueueQueued(companyId,enqueueLimit);
     const drained=await dispatcher.runOnce(companyId,batchSize);
     result.sent+=drained.sent;result.retried+=drained.retried;result.dead+=drained.dead;
    }catch{
     // One company's failure must not stop the others. Only the count is kept, so no tenant detail leaks.
     result.companyErrors++;
    }
   }
   return result;
  }finally{
   running=false;
  }
 }

 return{
  tick,
  start(intervalMs:number){
   if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw Error('inbox outbound worker: intervalMs must be at least 1000');
   const timer=setInterval(()=>{void tick();},intervalMs);
   timer.unref?.();
   return()=>clearInterval(timer);
  }
 };
}
