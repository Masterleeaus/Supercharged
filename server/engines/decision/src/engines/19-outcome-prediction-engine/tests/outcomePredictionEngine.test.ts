import assert from "node:assert/strict";
import { PredictionError, VALID_HORIZONS, buildPredictionSet, canonicalForecast } from "../runtime/outcomePredictionEngine.js";
const o=(id:string,c="c1")=>({option_id:id,company_id:c,decision_subject_id:"s1"});
const r=buildPredictionSet("c1","s1",[o("a")],{a:[{outcome_key:"cost",expected_value:10,confidence:.8,assumptions:["stable prices"],evidence_refs:["e1"]}]});
assert.equal(r.predictions[0].authority_effect,"none"); assert.ok(r.predictions[0].assumptions.includes("stable prices"));
assert.throws(()=>buildPredictionSet("c1","s1",[o("a","c2")],{}),PredictionError);
const bad=buildPredictionSet("c1","s1",[o("a")],{a:[{outcome_key:"x",confidence:2}]}); assert.equal(bad.predictions.length,0); assert.equal(bad.errors.length,1);
for (const h of VALID_HORIZONS) canonicalForecast("c1","s1","a",{outcome_key:h,horizon:h,confidence:.5});
console.log("Step19 TypeScript tests: 4 passed");
