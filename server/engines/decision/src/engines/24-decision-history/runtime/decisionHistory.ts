import { createHash } from "node:crypto";
export class DecisionHistoryError extends Error {}
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const id=(...p:unknown[])=>`dh_${createHash("sha256").update(p.map(String).join("|")).digest("hex").slice(0,20)}`;
export type DecisionHistoryEntry={history_id:string;company_id:string;decision_subject_id:string;decision_id:string;revision:number;snapshot_hash:string;snapshot:unknown;recorded_at:string;supersedes_history_id:string|null;reason:string;authority_effect:"none"};
export function appendDecisionHistory(companyId:string,decisionSubjectId:string,decisionId:string,snapshot:unknown,opts:{prior?:DecisionHistoryEntry;recorded_at?:string;reason?:string}={}):DecisionHistoryEntry{
 if(!companyId)throw new DecisionHistoryError("company_id_required"); if(!decisionSubjectId||!decisionId)throw new DecisionHistoryError("decision_identity_required");
 if(opts.prior){if(opts.prior.company_id!==companyId)throw new DecisionHistoryError("cross_company_history");if(opts.prior.decision_id!==decisionId)throw new DecisionHistoryError("decision_id_mismatch");}
 const revision=(opts.prior?.revision??0)+1; const snapshotHash=hash(snapshot); return {history_id:id(companyId,decisionId,revision,snapshotHash),company_id:companyId,decision_subject_id:decisionSubjectId,decision_id:decisionId,revision,snapshot_hash:snapshotHash,snapshot,recorded_at:opts.recorded_at??new Date().toISOString(),supersedes_history_id:opts.prior?.history_id??null,reason:opts.reason??"recorded",authority_effect:"none"};
}
export function verifyHistoryChain(entries:DecisionHistoryEntry[]){
 const sorted=[...entries].sort((a,b)=>a.revision-b.revision); for(let i=0;i<sorted.length;i++){const e=sorted[i];if(hash(e.snapshot)!==e.snapshot_hash)return false;if(i===0&&e.supersedes_history_id!==null)return false;if(i>0&&e.supersedes_history_id!==sorted[i-1].history_id)return false;if(i>0&&e.revision!==sorted[i-1].revision+1)return false;}return true;
}
