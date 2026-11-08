const text=(v,c)=>{const x=String(v??'').trim();if(!x)throw new Error(c);return x;};
const arr=v=>Array.isArray(v)?v:[];
const refs=v=>Object.freeze([...new Set(arr(v).map(x=>text(x,'mobile-release-reference-required')))].sort());
const company=v=>text(v,'mobile-release-company-id-required');
function reject(v,p='mobile-release'){if(!v||typeof v!=='object')return;if(Array.isArray(v))return v.forEach((x,i)=>reject(x,`${p}[${i}]`));for(const[k,x]of Object.entries(v)){if(['tenant_id','tenant_company_id','tenant_company'].includes(k))throw new Error(`legacy-company-boundary:${p}.${k}`);reject(x,`${p}.${k}`);}}
function check(id,passed,evidence=[],detail=''){return Object.freeze({check_id:id,status:passed?'PASS':'BLOCKED',evidence_refs:refs(evidence),detail});}

export function evaluateMobileReleaseCandidate(input={}){
 reject(input);const company_id=company(input.company_id);const candidate_id=text(input.candidate_id,'mobile-release-candidate-id-required');const checks=[];
 checks.push(check('android-build',input.android?.build_sha256,input.android?.evidence_refs,'Android build hash is required.'));
 checks.push(check('ios-build',input.ios?.build_sha256,input.ios?.evidence_refs,'iOS build hash is required.'));
 checks.push(check('android-signing',input.android?.signing_identity_ref&&input.android?.signing_mode==='production',input.android?.evidence_refs,'Android debug signing is never release certification.'));
 checks.push(check('ios-signing',input.ios?.signing_identity_ref&&input.ios?.signing_mode==='production',input.ios?.evidence_refs,'iOS production signing identity is required.'));
 checks.push(check('signed-manifest',input.signed_manifest_ref,input.evidence_refs,'Signed release manifest reference is required.'));
 checks.push(check('rollback-artifact',input.rollback?.artifact_sha256&&input.rollback?.verification_ref,input.rollback?.evidence_refs,'Rollback artifact and verification are required.'));
 checks.push(check('permissions',input.permissions?.declared===true&&input.permissions?.reviewed===true,input.permissions?.evidence_refs,'Camera/location/notifications/microphone/deep-link/background permissions require review evidence.'));
 if(input.push?.credential_ref&&!/^(?:cred|secret_ref):/.test(String(input.push.credential_ref)))throw new Error('mobile-release-plaintext-credential-rejected');
 checks.push(check('push-config',input.push?.configured===true&&input.push?.credential_ref,input.push?.evidence_refs,'Push configuration requires an opaque credential reference.'));
 const devices=arr(input.physical_device_evidence);checks.push(check('physical-devices',devices.length>=2&&devices.every(x=>x?.platform&&x?.device_ref&&x?.evidence_refs?.length),devices.flatMap(x=>x?.evidence_refs??[]),'At least one Android and one iOS physical-device evidence record are required.'));
 const blocked=checks.filter(x=>x.status==='BLOCKED');const ready=blocked.length===0;
 return Object.freeze({schema:'titan.mobile.release-certification.v1',company_id,candidate_id,state:ready?'CERTIFIED':'BLOCKED',checks,readiness:Object.freeze({certified:ready,ready_for_physical_certification:checks.filter(x=>x.check_id==='physical-devices')[0].status==='PASS',blockers:Object.freeze(blocked.map(x=>x.check_id))}),physical_device_evidence:Object.freeze(devices),secret_material_included:false,automatic_store_publish:false,authority_effect:false,grants_authority:false});
}

export function summarizeMobileReleaseCandidate(result={}){return Object.freeze({company_id:result.company_id,candidate_id:result.candidate_id,state:result.state,certified:result.readiness?.certified===true,blockers:arr(result.readiness?.blockers).length,physical_device_evidence:arr(result.physical_device_evidence).length,automatic_store_publish:false,grants_authority:false});}

