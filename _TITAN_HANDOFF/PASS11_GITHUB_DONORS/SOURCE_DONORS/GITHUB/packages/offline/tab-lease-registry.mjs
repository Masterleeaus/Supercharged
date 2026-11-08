const FORBIDDEN = new Set(['tenant_id','tenant_company_id','workspace_tenant_id']);
const clone = value => value == null ? value : (globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
const text = (value, field) => { const out = String(value ?? '').trim(); if (!out) throw new Error(`${field}-required`); return out; };
function rejectLegacy(value, path='tab-lease') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((child,index)=>rejectLegacy(child,`${path}[${index}]`)); return; }
  for (const [key,child] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) throw new Error(`legacy-company-boundary:${path}.${key}`);
    rejectLegacy(child,`${path}.${key}`);
  }
}
export function createCompanyTabLeaseRegistry({company_id, clock=()=>Date.now()}={}) {
  const boundCompanyId = text(company_id,'company_id');
  const byTab = new Map();
  const byOperation = new Map();
  const api = {
    company_id: boundCompanyId,
    authority_neutral: true,
    acquire(input={}, {replace_operation=false}={}) {
      rejectLegacy(input);
      const operation_id = text(input.operation_id,'operation_id');
      const tab_id = Number(input.tab_id);
      if (!Number.isInteger(tab_id)) throw new Error('tab_id-required');
      if (input.company_id && String(input.company_id).trim() !== boundCompanyId) throw new Error('cross-company:tab-lease');
      const tabExisting = byTab.get(tab_id);
      if (tabExisting && tabExisting.operation_id !== operation_id) throw new Error(`tab ${tab_id} already leased`);
      const opExisting = byOperation.get(operation_id);
      if (opExisting && opExisting.tab_id !== tab_id && !replace_operation) throw new Error(`operation ${operation_id} already owns tab ${opExisting.tab_id}`);
      if (opExisting && opExisting.tab_id !== tab_id) byTab.delete(opExisting.tab_id);
      const now = clock();
      const lease = Object.freeze({
        schema:'titan.offline.tab-lease.v1', company_id:boundCompanyId, operation_id, tab_id,
        url:String(input.url||''), title:String(input.title||''),
        acquired_at:tabExisting?.acquired_at ?? opExisting?.acquired_at ?? now, updated_at:now,
        authority_neutral:true, grants_authority:false,
      });
      byTab.set(tab_id, lease); byOperation.set(operation_id, lease); return clone(lease);
    },
    release(operation_id) {
      const id=text(operation_id,'operation_id'); const lease=byOperation.get(id); if(!lease) return false;
      byOperation.delete(id); byTab.delete(lease.tab_id); return true;
    },
    ownerOf(tab_id) { const row=byTab.get(Number(tab_id)); return row ? clone(row) : null; },
    leaseFor(operation_id) { const row=byOperation.get(String(operation_id)); return row ? clone(row) : null; },
    recoverExactUrl(operation_id,tabs=[]) {
      const prior=byOperation.get(String(operation_id)); if(!prior?.url) return null;
      const matches=(Array.isArray(tabs)?tabs:[]).filter(tab=>Number.isInteger(Number(tab?.id)) && String(tab?.url||'')===prior.url);
      if(matches.length!==1) return null;
      return api.acquire({company_id:boundCompanyId,operation_id:String(operation_id),tab_id:Number(matches[0].id),url:matches[0].url,title:matches[0].title||''},{replace_operation:true});
    },
    snapshot() { return Object.freeze([...byOperation.values()].map(clone)); },
  };
  return Object.freeze(api);
}
