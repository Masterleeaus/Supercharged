import { createHash } from "node:crypto";
export class BestActionError extends Error {}
const ident=(p:string,...xs:unknown[])=>`${p}_${createHash("sha256").update(xs.map(String).join("|")).digest("hex").slice(0,20)}`;
export type RankedAlternative={option_id:string;title?:string;score:number;rank_position:number;rank_confidence?:number;comparison_coverage?:number;assumptions?:string[];factors?:unknown[]};
export type RankingResult={ranking_id:string;company_id:string;decision_subject_id:string;leader_option_id?:string|null;leader_margin?:number;sensitivity?:{leader_is_sensitive?:boolean;scenarios?:unknown[]};ranked_alternatives:RankedAlternative[];excluded_alternatives?:unknown[]};
export function chooseBestAction(companyId:string,decisionSubjectId:string,ranking:RankingResult,opts:{minimum_confidence?:number;minimum_coverage?:number;minimum_margin?:number;created_at?:string}={}){
 if(!companyId) throw new BestActionError("company_id_required");
 if(ranking.company_id!==companyId) throw new BestActionError("cross_company_ranking");
 if(ranking.decision_subject_id!==decisionSubjectId) throw new BestActionError("decision_subject_mismatch");
 const minConf=opts.minimum_confidence??0.5,minCov=opts.minimum_coverage??0.5,minMargin=opts.minimum_margin??0;
 const leader=ranking.ranked_alternatives.find(x=>x.option_id===ranking.leader_option_id)??ranking.ranked_alternatives[0];
 if(!leader) return {decision_id:ident("best",companyId,decisionSubjectId,ranking.ranking_id),company_id:companyId,decision_subject_id:decisionSubjectId,ranking_id:ranking.ranking_id,status:"abstain",recommended_option_id:null,reasons:["no_eligible_ranked_alternative"],authority_effect:"none",created_at:opts.created_at??new Date().toISOString()};
 const reasons:string[]=[];
 if((leader.rank_confidence??0)<minConf) reasons.push("leader_confidence_below_threshold");
 if((leader.comparison_coverage??0)<minCov) reasons.push("leader_coverage_below_threshold");
 if((ranking.leader_margin??0)<minMargin) reasons.push("leader_margin_below_threshold");
 if(ranking.sensitivity?.leader_is_sensitive) reasons.push("leader_sensitive_to_weight_changes");
 const status=reasons.some(r=>r.includes("below_threshold"))?"abstain":"recommend";
 return {decision_id:ident("best",companyId,decisionSubjectId,ranking.ranking_id),contract_version:"1.0.0",company_id:companyId,decision_subject_id:decisionSubjectId,ranking_id:ranking.ranking_id,status,recommended_option_id:status==="recommend"?leader.option_id:null,leading_option_id:leader.option_id,leader_score:leader.score,leader_confidence:leader.rank_confidence??0,leader_coverage:leader.comparison_coverage??0,leader_margin:ranking.leader_margin??0,sensitive:Boolean(ranking.sensitivity?.leader_is_sensitive),reasons,assumptions:leader.assumptions??[],authority_effect:"none" as const,created_at:opts.created_at??new Date().toISOString()};
}
