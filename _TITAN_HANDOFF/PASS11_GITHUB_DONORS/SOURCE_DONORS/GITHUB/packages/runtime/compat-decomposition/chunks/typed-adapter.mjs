import {negotiateRuntimeAdapter,selectAdapterPath,ADAPTER_NEGOTIATION_SCHEMA} from '../../adapters/adapter-negotiation.mjs';
import {createAdapterSession,recoverAdapterSession,createReconnectPlan,ADAPTER_SESSION_RECOVERY_SCHEMA} from '../../adapters/adapter-session-recovery.mjs';

export const COMPAT_TYPED_ADAPTER_CHUNK_SCHEMA='titan.zero.compat-typed-adapter-chunk.v1';

export function createCompatTypedAdapterChunk(){
  return Object.freeze({
    schema:COMPAT_TYPED_ADAPTER_CHUNK_SCHEMA,
    negotiation_schema:ADAPTER_NEGOTIATION_SCHEMA,
    recovery_schema:ADAPTER_SESSION_RECOVERY_SCHEMA,
    negotiateRuntimeAdapter,
    selectAdapterPath,
    createAdapterSession,
    recoverAdapterSession,
    createReconnectPlan,
    authority_neutral:true,
    identity_confers_authority:false,
    adapter_grants_authority:false,
    loading_confers_authority:false
  });
}
