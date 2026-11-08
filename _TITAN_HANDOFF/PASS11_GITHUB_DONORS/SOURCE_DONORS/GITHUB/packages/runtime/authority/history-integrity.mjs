function stableCanonical(value){
  if(value==null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableCanonical(value[key])}`).join(',')}}`;
}

function fnv1a32(text){
  let hash=0x811c9dc5;
  for(let i=0;i<text.length;i++){
    hash^=text.charCodeAt(i);
    hash=Math.imul(hash,0x01000193)>>>0;
  }
  return hash.toString(16).padStart(8,'0');
}

export function buildAuthorityHistoryIntegritySeal(namespace, history){
  const ns=String(namespace??'').trim();
  if(!ns) throw new Error('authority-history-namespace-required');
  if(!Array.isArray(history)) throw new Error('authority-history-array-required');
  let link=`titan.authority-history.v1|${ns}|root`;
  for(let i=0;i<history.length;i++){
    link=fnv1a32(`${link}|${i}|${stableCanonical(history[i])}`);
  }
  return `titan.authority-history.v1|${ns}|${history.length}|${link}`;
}

export { stableCanonical as stableAuthorityHistoryCanonical };

export function buildAuthorityHistorySnapshotSeal(namespace, history, previousSnapshotSeal='root'){
  const ns=String(namespace??'').trim();
  if(!ns) throw new Error('authority-history-namespace-required');
  if(!Array.isArray(history)) throw new Error('authority-history-array-required');
  const parent=String(previousSnapshotSeal??'root').trim()||'root';
  const historySeal=buildAuthorityHistoryIntegritySeal(ns,history);
  return `titan.authority-history-snapshot.v1|${ns}|${history.length}|${parent}|${historySeal}`;
}

export function assertAuthorityHistorySnapshotLink(snapshot, expectedPreviousSnapshotSeal='root'){
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)) throw new Error('authority-history-snapshot-required');
  const ns=String(snapshot.namespace??'').trim();
  if(!ns) throw new Error('authority-history-namespace-required');
  if(!Array.isArray(snapshot.history)) throw new Error('authority-history-array-required');
  const expectedParent=String(expectedPreviousSnapshotSeal??'root').trim()||'root';
  const actualParent=String(snapshot.previous_snapshot_seal??'root').trim()||'root';
  if(actualParent!==expectedParent) throw new Error('authority-history-snapshot-parent-mismatch');
  const expectedSeal=buildAuthorityHistorySnapshotSeal(ns,snapshot.history,actualParent);
  if(String(snapshot.snapshot_seal??'')!==expectedSeal) throw new Error('authority-history-snapshot-seal-mismatch');
  return true;
}


export function assertAuthorityHistorySnapshotChain(snapshots){
  if(!Array.isArray(snapshots)||snapshots.length===0) throw new Error('authority-history-snapshot-chain-required');
  const seenSeals=new Set();
  let previousSeal='root';
  let namespace=null;
  let previousLength=-1;
  for(const snapshot of snapshots){
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)) throw new Error('authority-history-snapshot-required');
    const currentNamespace=String(snapshot.namespace??'').trim();
    if(!currentNamespace) throw new Error('authority-history-namespace-required');
    if(namespace==null) namespace=currentNamespace;
    else if(currentNamespace!==namespace) throw new Error('authority-history-snapshot-namespace-mismatch');
    const seal=String(snapshot.snapshot_seal??'').trim();
    if(seenSeals.has(seal)) throw new Error('authority-history-snapshot-seal-reuse');
    assertAuthorityHistorySnapshotLink(snapshot,previousSeal);
    if(snapshot.history.length<previousLength) throw new Error('authority-history-snapshot-history-rollback');
    seenSeals.add(seal);
    previousSeal=seal;
    previousLength=snapshot.history.length;
  }
  return true;
}
