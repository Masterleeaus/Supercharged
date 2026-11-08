/**
 * Bounded non-PII reply proposal orchestration. This is not a background
 * worker, a communications provider or a persistence implementation.
 */
import {captureVerifiedDeskReply, ReplyCaptureUnavailable} from './reply-capture.mjs';
import {parseProposalReceipt} from './reply-protocol.mjs';

export const MAX_REPLY_BATCH = 20;
export async function runReplyShadowBatch(events, {
  verifyProviderEvent, resolveFieldContext, classify, submitProposal,
  dryRun = true, now = Date.now()
} = {}) {
  if (!Array.isArray(events) || events.length>MAX_REPLY_BATCH)
    throw new ReplyCaptureUnavailable('reply_batch_size_invalid');
  if (!dryRun && typeof submitProposal!=='function')
    throw new ReplyCaptureUnavailable('reply_submit_port_required');
  const summary={mode:dryRun?'preview':'shadow',scanned:events.length,eligible:0,proposed:0,
    duplicates:0,skipped:0,failed:0,events:[]};
  const seen=new Set();
  for (const event of events) {
    let prepared;
    try {
      prepared=await captureVerifiedDeskReply(event,{verifyProviderEvent,resolveFieldContext,
        classify,dryRun:true,now});
    } catch (error) {
      summary.skipped++;
      summary.events.push({status:'skipped',reason:error instanceof ReplyCaptureUnavailable
        ? error.code : 'reply_dependency_unavailable'});
      continue;
    }
    const proposal=prepared.proposal;
    const token=`${proposal.company_id}:${proposal.event_id}`;
    if (seen.has(token)) {
      summary.duplicates++;
      summary.events.push({event_id:proposal.event_id,status:'duplicate_local',action_executed:false});
      continue;
    }
    seen.add(token);summary.eligible++;
    if (dryRun) {
      summary.events.push({event_id:proposal.event_id,status:'eligible',action_executed:false});
      continue;
    }
    try {
      const receipt=parseProposalReceipt(await submitProposal(proposal),proposal);
      if (receipt.status==='duplicate') summary.duplicates++;
      else summary.proposed++;
      summary.events.push({event_id:proposal.event_id,status:receipt.status,action_executed:false});
    } catch {
      summary.failed++;
      summary.events.push({event_id:proposal.event_id,status:'field_unavailable',action_executed:false});
    }
  }
  return Object.freeze(summary);
}
