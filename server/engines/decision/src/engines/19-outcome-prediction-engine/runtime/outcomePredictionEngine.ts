import { createHash } from "node:crypto";

export class PredictionError extends Error {}
export const VALID_HORIZONS = new Set(["immediate","near_term","operational","tactical","strategic"] as const);
export const VALID_STATES = new Set(["estimate","range","distribution","unknown"] as const);

export type Forecast = {
  prediction_id?: string; company_id?: string; decision_subject_id?: string; option_id?: string;
  outcome_key: string; state?: string; horizon?: string; expected_value?: number | null;
  lower_bound?: number | null; upper_bound?: number | null; unit?: string | null; confidence?: number;
  assumptions?: string[]; evidence_refs?: string[]; model_id?: string; model_version?: string;
  calibration_ref?: string | null; expires_at?: string | null; generated_at?: string; authority_effect?: "none";
};
export type OptionRef = { option_id: string; company_id: string; decision_subject_id: string };
export type PredictionSet = { prediction_set_id:string; contract_version:"1.0.0"; company_id:string; decision_subject_id:string; predictions:Required<Forecast>[]; errors:Array<{option_id:string;error:string;outcome_key?:string}>; created_at:string; authority_effect:"none"; metadata:Record<string,unknown> };

const now = () => new Date().toISOString();
const id = (prefix:string,...parts:unknown[]) => `${prefix}_${createHash("sha256").update(parts.map(String).join("|")).digest("hex").slice(0,20)}`;
const finite = (v:unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function canonicalForecast(companyId:string, decisionSubjectId:string, optionId:string, input:Forecast): Required<Forecast> {
  if (!companyId) throw new PredictionError("company_id_required");
  const x: Forecast = { ...input };
  if ((x.company_id ?? companyId) !== companyId) throw new PredictionError("cross_company_prediction");
  if ((x.decision_subject_id ?? decisionSubjectId) !== decisionSubjectId) throw new PredictionError("decision_subject_mismatch");
  if ((x.option_id ?? optionId) !== optionId) throw new PredictionError("option_mismatch");
  if (!x.outcome_key) throw new PredictionError("outcome_key_required");
  x.company_id=companyId; x.decision_subject_id=decisionSubjectId; x.option_id=optionId;
  x.prediction_id ??= id("pred",companyId,decisionSubjectId,optionId,x.outcome_key,x.model_version ?? "unspecified");
  x.state ??= "estimate"; x.horizon ??= "operational"; x.expected_value ??= null; x.lower_bound ??= null; x.upper_bound ??= null;
  x.unit ??= null; x.confidence ??= 0; x.assumptions ??= []; x.evidence_refs ??= []; x.model_id ??= "declared-provider"; x.model_version ??= "unspecified";
  x.calibration_ref ??= null; x.expires_at ??= null; x.generated_at ??= now(); x.authority_effect = "none";
  if (!VALID_STATES.has(x.state as any)) throw new PredictionError("bad_state");
  if (!VALID_HORIZONS.has(x.horizon as any)) throw new PredictionError("bad_horizon");
  if (!(x.confidence >= 0 && x.confidence <= 1)) throw new PredictionError("confidence_range");
  if (x.expected_value !== null && !finite(x.expected_value)) throw new PredictionError("non_finite_expected_value");
  if (x.lower_bound !== null && x.upper_bound !== null && x.lower_bound > x.upper_bound) throw new PredictionError("bad_bounds");
  return x as Required<Forecast>;
}

export function buildPredictionSet(companyId:string, decisionSubjectId:string, options:OptionRef[], forecastsByOption:Record<string,Forecast[]>, opts:{created_at?:string;metadata?:Record<string,unknown>}={}): PredictionSet {
  const optionIds:string[]=[]; const predictions:Required<Forecast>[]=[]; const errors:PredictionSet["errors"]=[];
  for (const option of options) {
    if (option.company_id !== companyId) throw new PredictionError("cross_company_option");
    if (option.decision_subject_id !== decisionSubjectId) throw new PredictionError("decision_subject_mismatch");
    optionIds.push(option.option_id);
    for (const raw of forecastsByOption[option.option_id] ?? []) {
      try { predictions.push(canonicalForecast(companyId,decisionSubjectId,option.option_id,raw)); }
      catch (err) { if (!(err instanceof PredictionError)) throw err; errors.push({option_id:option.option_id,error:err.message,outcome_key:raw.outcome_key}); }
    }
  }
  return {prediction_set_id:id("predset",companyId,decisionSubjectId,...optionIds),contract_version:"1.0.0",company_id:companyId,decision_subject_id:decisionSubjectId,predictions,errors,created_at:opts.created_at ?? now(),authority_effect:"none",metadata:opts.metadata ?? {}};
}

export function byOption(predictionSet:PredictionSet | {predictions?:Required<Forecast>[]}): Record<string,Required<Forecast>[]> {
  const out:Record<string,Required<Forecast>[]>= {}; for (const p of predictionSet.predictions ?? []) (out[p.option_id] ??= []).push(p); return out;
}
