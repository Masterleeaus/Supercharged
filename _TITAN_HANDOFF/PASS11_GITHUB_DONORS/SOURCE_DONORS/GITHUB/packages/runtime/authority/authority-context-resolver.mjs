import { evaluateWorkerAuthorityDecision } from "./authority-evaluator.mjs";

const required=(value,code)=>{const text=String(value??"").trim();if(!text)throw new Error(code);return text;};

/**
 * Read-only projection of persisted authority facts into the existing evaluator.
 * Missing facts never become permission: restrictive defaults intentionally make
 * the canonical evaluator return DENY / AUTHORITY_UNAVAILABLE / evidence waits.
 */
export class AuthorityContextResolver {
  constructor({authorityStore, requirementResolver, accessResolver, governanceResolver, evidenceResolver, riskResolver, connectivityResolver, usageResolver}={}){
    if(!authorityStore)throw new Error("authority-context-store-required");
    this.store=authorityStore;
    this.requirementResolver=requirementResolver;
    this.accessResolver=accessResolver;
    this.governanceResolver=governanceResolver;
    this.evidenceResolver=evidenceResolver;
    this.riskResolver=riskResolver;
    this.connectivityResolver=connectivityResolver;
    this.usageResolver=usageResolver;
  }

  async evaluate(input){
    const company_id=required(input?.company_id,"authority-company-id-required");
    const worker_id=required(input?.agent_id??input?.worker_id,"authority-worker-id-required");
    const capability=required(input?.capability,"authority-capability-required");
    const operation_id=required(input?.operation_id??input?.run_id,"authority-operation-id-required");
    const action_id=required(input?.action_id??input?.idempotency_key??operation_id,"authority-action-id-required");

    const [autonomy_snapshot,requirement,access,governance,evidence,risk,connectivity,approval,usage]=await Promise.all([
      this.store.latestAutonomySnapshot({company_id,capability,worker_id}),
      this.requirementResolver?.resolve?.({company_id,worker_id,capability,input})??null,
      this.accessResolver?.resolve?.({company_id,worker_id,capability,input})??null,
      this.governanceResolver?.resolve?.({company_id,worker_id,capability,input})??null,
      this.evidenceResolver?.resolve?.({company_id,worker_id,capability,input})??null,
      this.riskResolver?.resolve?.({company_id,worker_id,capability,input})??null,
      this.connectivityResolver?.resolve?.({company_id,worker_id,capability,input})??null,
      this.store.latestApproval({company_id,approval_scope:action_id}),
      this.usageResolver?.resolve?.({company_id,worker_id,capability,input})??input.authority_usage??input.execution_input?.authority_usage??null,
    ]);

    const decision=evaluateWorkerAuthorityDecision({
      authority_decision_id:input.authority_decision_id??`authority:${operation_id}:${action_id}`,
      company_id,actor_id:input.actor_id,operation_id,action_id,
      worker:{worker_id,worker_type:input.worker_type??"advanced-intelligence-worker",surface:input.surface??"zero"},
      requirement:requirement??{company_id,capability,effect:"write",required_permissions:["authority.context.missing"],minimum_autonomy_score:100},
      autonomy_snapshot,
      permissions:access?.permissions??[],
      entitlements:access?.entitlements??[],
      policy_allows:governance?.policy_allows===true,
      governance_allows:governance?.governance_allows===true,
      assurance_allows:governance?.assurance_allows===true,
      risk:risk?.level??"critical",
      usage:usage??{},
      evidence:evidence??{status:"missing",refs:[]},
      approval:approval??{company_id,status:"not_required"},
      connectivity:connectivity?.state??"offline",
      execution_mode:input.execution_mode??"autonomous",
      now:input.now??new Date().toISOString(),
    });
    return Object.freeze({
      ...decision,
      evaluated_risk:Object.freeze({level:risk?.level??"critical",source:risk?.source??null,ref:risk?.ref??null}),
    });
  }
}
