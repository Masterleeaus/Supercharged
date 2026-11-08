import {
  normalizeVerifiedAutonomySnapshot,
  assertAuthorityDecisionSupersessionContinuity,
} from "./index.mjs";

const required=(value,code)=>{const text=String(value??"").trim();if(!text)throw new Error(code);return text;};
const parse=row=>row?JSON.parse(row.payload):null;

export class SqliteAuthorityStore {
  constructor(storage){if(!storage||typeof storage.query!=="function")throw new Error("authority-storage-required");this.storage=storage;}

  async appendAutonomySnapshot(input,{worker_id=null}={}){
    const snapshot=normalizeVerifiedAutonomySnapshot(input);
    await this.storage.query(
      `INSERT INTO authority_autonomy_snapshots(company_id,decision_id,capability,worker_id,status,verified_at,expires_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [snapshot.company_id,snapshot.decision_id,snapshot.capability,worker_id,snapshot.status,snapshot.verified_at,snapshot.expires_at,JSON.stringify(snapshot)],
    );
    return snapshot;
  }

  async latestAutonomySnapshot({company_id,capability,worker_id=null}){
    company_id=required(company_id,"authority-company-id-required");
    capability=required(capability,"authority-capability-required");
    const result=await this.storage.query(
      `SELECT payload FROM authority_autonomy_snapshots
       WHERE company_id=$1 AND capability=$2 AND (worker_id=$3 OR worker_id IS NULL)
       ORDER BY CASE WHEN worker_id=$3 THEN 0 ELSE 1 END, verified_at DESC, created_at DESC LIMIT 1`,
      [company_id,capability,worker_id],
    );
    return parse(result.rows[0]);
  }

  async appendDecision(decision){
    const company_id=required(decision?.company_id,"authority-company-id-required");
    const id=required(decision?.authority_decision_id,"authority-decision-id-required");
    const worker_id=required(decision?.worker_id,"authority-worker-id-required");
    const capability=required(decision?.capability,"authority-capability-required");
    const evaluated_at=required(decision?.evaluated_at,"authority-evaluated-at-required");
    const parent=decision?.supersedes_authority_decision_id?String(decision.supersedes_authority_decision_id):null;
    if(parent){
      const prior=await this.getDecision(company_id,parent);
      if(!prior)throw new Error("authority-supersession-parent-missing");
      assertAuthorityDecisionSupersessionContinuity(prior,decision);
      const child=await this.storage.query(
        `SELECT authority_decision_id FROM authority_decisions
         WHERE company_id=$1 AND supersedes_authority_decision_id=$2
         ORDER BY evaluated_at DESC, created_at DESC LIMIT 1`,
        [company_id,parent],
      );
      if(child.rows[0]&&String(child.rows[0].authority_decision_id)!==id)throw new Error("authority-supersession-fork");
    }
    await this.storage.query(
      `INSERT INTO authority_decisions(company_id,authority_decision_id,worker_id,capability,operation_id,action_id,decision,evaluated_at,supersedes_authority_decision_id,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [company_id,id,worker_id,capability,decision.operation_id??null,decision.action_id??null,required(decision.decision,"authority-decision-required"),evaluated_at,parent,JSON.stringify(decision)],
    );
    return decision;
  }

  async getDecision(company_id,authority_decision_id){
    const result=await this.storage.query(
      `SELECT payload FROM authority_decisions WHERE company_id=$1 AND authority_decision_id=$2 LIMIT 1`,
      [required(company_id,"authority-company-id-required"),required(authority_decision_id,"authority-decision-id-required")],
    );
    return parse(result.rows[0]);
  }

  async latestDecisionForBinding({company_id,worker_id,capability,operation_id,action_id}){
    const result=await this.storage.query(
      `SELECT payload FROM authority_decisions
       WHERE company_id=$1 AND worker_id=$2 AND capability=$3
         AND operation_id=$4 AND action_id=$5
       ORDER BY evaluated_at DESC, created_at DESC LIMIT 1`,
      [
        required(company_id,"authority-company-id-required"),
        required(worker_id,"authority-worker-id-required"),
        required(capability,"authority-capability-required"),
        required(operation_id,"authority-operation-id-required"),
        required(action_id,"authority-action-id-required"),
      ],
    );
    return parse(result.rows[0]);
  }

  async appendApproval(input){
    const company_id=required(input?.company_id,"authority-company-id-required");
    const approval_id=required(input?.approval_id,"approval-id-required");
    const approval_scope=required(input?.approval_scope,"approval-scope-required");
    const status=required(input?.status,"approval-status-required");
    await this.storage.query(
      `INSERT INTO authority_approvals(company_id,approval_id,approval_scope,status,approver_id,granted_at,expires_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [company_id,approval_id,approval_scope,status,input.approver_id??null,input.granted_at??null,input.expires_at??null,JSON.stringify(input)],
    );
    return input;
  }

  async latestApproval({company_id,approval_scope}){
    const result=await this.storage.query(
      `SELECT payload FROM authority_approvals WHERE company_id=$1 AND approval_scope=$2
       ORDER BY created_at DESC, approval_id DESC LIMIT 1`,
      [required(company_id,"authority-company-id-required"),required(approval_scope,"approval-scope-required")],
    );
    return parse(result.rows[0]);
  }
}
