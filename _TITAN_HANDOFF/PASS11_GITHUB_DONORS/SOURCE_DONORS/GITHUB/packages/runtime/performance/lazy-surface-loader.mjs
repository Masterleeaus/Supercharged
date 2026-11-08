const DEFAULT_SURFACES = Object.freeze({
  'diagnostics.bootstrapProfiler': Object.freeze({kind:'module', path:'../../diagnostics/startup/bootstrap-performance-profiler.mjs', startup_required:false, company_scoped:false}),
  'workforce.graph': Object.freeze({kind:'module', path:'../../titan-workforce/graph/workforce-graph.mjs', startup_required:false, company_scoped:true}),
  'marketplace.catalog': Object.freeze({kind:'json', path:'../../titan-modules/marketplace/catalog.json', startup_required:false, company_scoped:true})
});

export const LAZY_SURFACE_SCHEMA = 'titan.zero.lazy-surface.v1';

function cleanCompanyId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('company_id_required');
  return value.trim();
}

function rejectLegacyAuthority(input) {
  const stack=[input];
  while (stack.length) {
    const value=stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Object.hasOwn(value,'tenant_id') || Object.hasOwn(value,'tenant_company_id')) throw new Error('legacy_tenant_authority_rejected');
    for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
  }
}

function descriptorFor(registry, surface) {
  const descriptor=registry[surface];
  if (!descriptor) throw new Error(`unknown_lazy_surface:${surface}`);
  if (descriptor.startup_required === true) throw new Error(`startup_surface_not_lazy:${surface}`);
  return descriptor;
}

export function createLazySurfaceLoader({
  registry=DEFAULT_SURFACES,
  moduleLoader=(url)=>import(url),
  jsonLoader=async(url)=>{
    const response=await fetch(url);
    if (!response.ok) throw new Error(`lazy_json_load_failed:${response.status}`);
    return response.json();
  },
  resolveUrl=(relative)=>new URL(relative, import.meta.url).href,
  auditSink=()=>{}
}={}) {
  const cache=new Map();
  const inFlight=new Map();

  function describe(surface) {
    const descriptor=descriptorFor(registry,surface);
    return Object.freeze({
      schema:LAZY_SURFACE_SCHEMA,
      surface,
      kind:descriptor.kind,
      startup_required:false,
      company_scoped:descriptor.company_scoped === true,
      loaded:cache.has(surface),
      loading:inFlight.has(surface),
      authority_neutral:true,
      identity_confers_authority:false,
      loading_confers_authority:false
    });
  }

  async function load(input={}) {
    rejectLegacyAuthority(input);
    const surface=String(input.surface || '');
    const descriptor=descriptorFor(registry,surface);
    const companyId=descriptor.company_scoped ? cleanCompanyId(input.company_id) : null;
    if (cache.has(surface)) return {value:cache.get(surface), state:describe(surface), company_id:companyId};
    if (inFlight.has(surface)) return inFlight.get(surface);
    const task=(async()=>{
      auditSink({schema:LAZY_SURFACE_SCHEMA,action:'load',surface,company_id:companyId,outcome:'started',authority_neutral:true});
      try {
        const url=resolveUrl(descriptor.path);
        const value=descriptor.kind === 'json' ? await jsonLoader(url) : await moduleLoader(url);
        cache.set(surface,value);
        auditSink({schema:LAZY_SURFACE_SCHEMA,action:'load',surface,company_id:companyId,outcome:'loaded',authority_neutral:true});
        return {value,state:describe(surface),company_id:companyId};
      } catch (error) {
        auditSink({schema:LAZY_SURFACE_SCHEMA,action:'load',surface,company_id:companyId,outcome:'failed',authority_neutral:true,error:String(error?.message || error)});
        throw error;
      } finally {
        inFlight.delete(surface);
      }
    })();
    inFlight.set(surface,task);
    return task;
  }

  function clear(surface) {
    if (surface == null) { cache.clear(); return; }
    descriptorFor(registry,surface);
    cache.delete(surface);
  }

  return Object.freeze({describe,load,clear,list:()=>Object.keys(registry).sort()});
}
