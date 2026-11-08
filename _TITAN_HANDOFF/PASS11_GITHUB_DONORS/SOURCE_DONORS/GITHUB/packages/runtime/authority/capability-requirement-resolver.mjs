const SCORE=Object.freeze({suggest:0,assist:16,semi_auto:31,auto:51,trusted_auto:71,predictive:86});
const text=value=>String(value??"").trim();
const list=value=>Array.isArray(value)?[...new Set(value.map(v=>String(v).trim()).filter(Boolean))]:[];

function findEntry(registry,capability){
  const id=text(capability);
  if(!id)return null;
  const entry=registry?.entries?.find(entry=>
    entry.id===id || entry.registry_id===id || entry.capabilities?.includes?.(id)
  );
  if(entry)return entry;
  const action=registry?.action_capabilities?.find(item=>(item.capability_id??item.id)===id);
  if(!action)return null;
  // #7 stores host actions in the same canonical registry while keeping them
  // out of the general tool/launch projection. Normalize only at the existing
  // authority contract boundary; do not create another action catalogue.
  return {
    ...action,
    id,
    registry_id:id,
    permissions:action.required_permissions??[],
    raw:action,
  };
}

function effectFor(entry){
  if(!entry?.mutates)return "read";
  const raw=text(entry.raw?.effect??entry.raw?.operation??entry.raw?.action).toLowerCase();
  if(["write","submit","purchase","payment","delete","publish","send","approve","sign","book","cancel","reschedule"].includes(raw))return raw;
  return "write";
}

/** Translate the canonical Capability Registry into the existing Authority requirement contract. */
export class CapabilityRequirementResolver {
  constructor({registry,registryProvider}={}){
    if(!registry&&!registryProvider?.load)throw new Error("capability-requirement-registry-required");
    this.registry=registry;this.registryProvider=registryProvider;
  }

  async resolve({company_id,capability}={}){
    const registry=this.registryProvider?.load?await this.registryProvider.load({company_id}):this.registry;
    if(registry?.company_id&&String(registry.company_id)!==String(company_id))throw new Error("capability-registry-company-mismatch");
    const entry=findEntry(registry,capability);
    if(!entry)return null;
    const contract=entry.execution_contract??{};
    const evidence=list(contract.evidence_required??entry.raw?.evidenceRequired??entry.raw?.evidence_required);
    const approvalFor=list(contract.approval_required_for??entry.raw?.approvalRequiredFor??entry.raw?.approval_required_for);
    const autonomy=text(contract.autonomy??entry.autonomy).toLowerCase();
    const effect=effectFor(entry);
    const protectedAction=effect!=="read";
    return Object.freeze({
      company_id:String(company_id),
      capability:String(capability),
      variant:entry.raw?.variant??null,
      workflow:entry.workflow??entry.raw?.workflow??null,
      context_ref:null,
      operation:text(entry.raw?.operation)||"execute",
      effect,
      action_class:text(entry.raw?.action_class??entry.raw?.actionClass)||null,
      target:text(entry.raw?.target)||null,
      protected_action:protectedAction,
      required_permissions:list(entry.permissions),
      required_entitlements:list(entry.raw?.entitlements??entry.raw?.required_entitlements),
      required_evidence:evidence,
      minimum_autonomy_score:SCORE[autonomy]??(protectedAction?51:0),
      approval_policy:approvalFor.length?"registry_required":null,
      reversibility:text(entry.raw?.reversibility)||"unknown",
      evidence_refs:[],
      registry_id:entry.registry_id,
      risk_class:text(entry.risk_class||"LOW").toLowerCase(),
      risk_ceiling:text(entry.risk_ceiling).toLowerCase()||null,
    });
  }
}
