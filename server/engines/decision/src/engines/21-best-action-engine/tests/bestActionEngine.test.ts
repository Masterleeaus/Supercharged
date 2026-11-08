import assert from "node:assert/strict"; import {BestActionError,chooseBestAction} from "../runtime/bestActionEngine.js";
const ranking:any={ranking_id:"r1",company_id:"c1",decision_subject_id:"s1",leader_option_id:"a",leader_margin:.2,sensitivity:{leader_is_sensitive:false},ranked_alternatives:[{option_id:"a",score:.8,rank_position:1,rank_confidence:.9,comparison_coverage:.95},{option_id:"b",score:.6,rank_position:2,rank_confidence:.9,comparison_coverage:.95}]};
let r=chooseBestAction("c1","s1",ranking);assert.equal(r.status,"recommend");assert.equal(r.recommended_option_id,"a");assert.equal(r.authority_effect,"none");
r=chooseBestAction("c1","s1",{...ranking,ranked_alternatives:[{...ranking.ranked_alternatives[0],rank_confidence:.2}]});assert.equal(r.status,"abstain");
assert.throws(()=>chooseBestAction("c2","s1",ranking),BestActionError);console.log("Step21 TypeScript tests: 3 passed");
