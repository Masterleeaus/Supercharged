import {capturePageEvidence} from '../../knowledge/page-evidence.mjs';

export const COMPAT_DOCUMENT_EVIDENCE_CHUNK_SCHEMA='titan.zero.compat-document-evidence-chunk.v1';

export function createCompatDocumentEvidenceChunk({company_id}={}){
  const cid=String(company_id||'').trim();
  if(!cid) throw new Error('company_id_required');
  return Object.freeze({
    schema:COMPAT_DOCUMENT_EVIDENCE_CHUNK_SCHEMA,
    company_id:cid,
    capture:(raw={})=>capturePageEvidence(raw,{company_id:cid}),
    authority_neutral:true,
    identity_confers_authority:false,
    loading_confers_authority:false
  });
}
