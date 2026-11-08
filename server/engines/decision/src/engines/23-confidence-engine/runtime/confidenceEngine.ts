import { createHash } from "node:crypto";
export class ConfidenceError extends Error {}
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const id=(prefix:string,...parts:unknown[])=>`${prefix}_${createHash("sha256").update(parts.map(String).join("|")).digest("hex").slice(0,20)}`;
export type CalibrationBin={lower:number;upper:number;observed_success:number;sample_count:number};
export type CalibrationProfile={profile_id:string;company_id:string;decision_scope:string;revision:number;bins:CalibrationBin[];created_at:string;supersedes_profile_id?:string|null};
export function calibrateConfidence(companyId:string, rawConfidence:number, profile?:CalibrationProfile, decisionScope="default"){
 if(!companyId) throw new ConfidenceError("company_id_required"); if(!Number.isFinite(rawConfidence)) throw new ConfidenceError("confidence_must_be_finite"); const raw=clamp(rawConfidence);
 if(profile && profile.company_id!==companyId) throw new ConfidenceError("cross_company_profile"); if(profile && profile.decision_scope!==decisionScope) throw new ConfidenceError("profile_scope_mismatch");
 const bin=profile?.bins.find(b=>raw>=b.lower && (raw<b.upper || (raw===1&&b.upper===1))); const calibrated=bin && bin.sample_count>0 ? clamp(bin.observed_success) : raw;
 return {confidence_id:id("conf",companyId,decisionScope,raw,profile?.profile_id??"identity"),company_id:companyId,decision_scope:decisionScope,raw_confidence:raw,calibrated_confidence:calibrated,calibration_profile_id:profile?.profile_id??null,calibration_sample_count:bin?.sample_count??0,calibration_basis:bin?"observed_outcomes":"identity",authority_effect:"none" as const};
}
