export const DONOR_SURFACE_ACTIVATION_SCHEMA = 'titan.zero.donor-surface-activation.v1';

const DEFAULT_SURFACES = Object.freeze({
  chatTab: Object.freeze({
    runtime: 'titan-zero-chat-content.compat.js',
    activation: 'page_open',
    startup_required: false,
    retained_compatibility: true,
  }),
  monicaOptions: Object.freeze({
    runtime: 'titan-zero-chat-content.compat.js',
    activation: 'page_open',
    startup_required: false,
    retained_compatibility: true,
  }),
  monicaPopup: Object.freeze({
    runtime: 'titan-zero-chat-runtime.compat.js',
    stylesheet: 'titan-zero-chat-runtime.compat.css',
    activation: 'page_open',
    startup_required: false,
    retained_compatibility: true,
  }),
  retrieverBackground: Object.freeze({
    runtime: 'retriever-background.iife.js',
    activation: 'background_boundary',
    startup_required: true,
    retained_compatibility: true,
    deferred_retirement_gate: 'TZ-FIX-RUNTIME-ADAPTERS-001_MANAGER_MERGED',
  }),
});

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
  if (!descriptor) throw new Error(`unknown_donor_surface:${surface}`);
  return descriptor;
}

export function createDonorSurfaceActivation({
  registry=DEFAULT_SURFACES,
  moduleLoader=(url)=>import(url),
  resolveUrl=(relative)=>new URL(`../../${relative}`, import.meta.url).href,
  auditSink=()=>{},
}={}) {
  const loaded=new Map();
  const inFlight=new Map();

  function describe(surface) {
    const descriptor=descriptorFor(registry,surface);
    return Object.freeze({
      schema:DONOR_SURFACE_ACTIVATION_SCHEMA,
      surface,
      runtime:descriptor.runtime,
      stylesheet:descriptor.stylesheet || null,
      activation:descriptor.activation,
      startup_required:descriptor.startup_required === true,
      retained_compatibility:descriptor.retained_compatibility === true,
      deferred_retirement_gate:descriptor.deferred_retirement_gate || null,
      loaded:loaded.has(surface),
      loading:inFlight.has(surface),
      authority_neutral:true,
      identity_confers_authority:false,
      activation_confers_authority:false,
    });
  }

  async function activate(input={}) {
    rejectLegacyAuthority(input);
    const surface=String(input.surface || '');
    const descriptor=descriptorFor(registry,surface);
    if (descriptor.startup_required === true) throw new Error(`startup_bound_surface_not_deferred:${surface}`);
    if (input.explicit_surface_open !== true) throw new Error('explicit_surface_open_required');
    if (loaded.has(surface)) return {value:loaded.get(surface), state:describe(surface)};
    if (inFlight.has(surface)) return inFlight.get(surface);
    const task=(async()=>{
      auditSink({schema:DONOR_SURFACE_ACTIVATION_SCHEMA,surface,action:'activate',outcome:'started',authority_neutral:true});
      try {
        const value=await moduleLoader(resolveUrl(descriptor.runtime));
        loaded.set(surface,value);
        auditSink({schema:DONOR_SURFACE_ACTIVATION_SCHEMA,surface,action:'activate',outcome:'loaded',authority_neutral:true});
        return {value,state:describe(surface)};
      } catch (error) {
        auditSink({schema:DONOR_SURFACE_ACTIVATION_SCHEMA,surface,action:'activate',outcome:'failed',authority_neutral:true,error:String(error?.message || error)});
        throw error;
      } finally { inFlight.delete(surface); }
    })();
    inFlight.set(surface,task);
    return task;
  }

  return Object.freeze({describe,activate,list:()=>Object.keys(registry).sort()});
}

export function getDefaultDonorSurfaceRegistry() {
  return DEFAULT_SURFACES;
}
