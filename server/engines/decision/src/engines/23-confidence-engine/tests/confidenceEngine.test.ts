import assert from "node:assert/strict"; import {calibrateConfidence,ConfidenceError} from "../runtime/confidenceEngine.js";
const profile={profile_id:"cp1",company_id:"c1",decision_scope:"ops",revision:1,created_at:"2026-01-01T00:00:00Z",bins:[{lower:0,upper:.8,observed_success:.55,sample_count:20},{lower:.8,upper:1,observed_success:.76,sample_count:25}]};
assert.equal(calibrateConfidence("c1",.9,profile,"ops").calibrated_confidence,.76);
assert.equal(calibrateConfidence("c1",.4,undefined,"ops").calibrated_confidence,.4);
assert.equal(calibrateConfidence("c1",1,profile,"ops").authority_effect,"none");
assert.throws(()=>calibrateConfidence("c2",.9,profile,"ops"),ConfidenceError);
assert.throws(()=>calibrateConfidence("",.5),ConfidenceError);
console.log("confidence-engine tests passed: 5");
