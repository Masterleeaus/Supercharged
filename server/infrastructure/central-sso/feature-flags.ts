/** Central-governed feature flags with local declared defaults (contract: Central docs/CONFIG.md, quoted in #196).
 * Resolution order when a snapshot is present: organisation override, rollout, global, declared default.
 * The Central flag read endpoint is not live, so with no snapshot every read returns the declared default.
 * Central being unreachable never throws to the caller.
 */
export const FLAG_PRODUCT='supercharged';

export type FlagValue=boolean|number|string;
export interface FlagSnapshotEntry{organisation?:FlagValue;rollout?:FlagValue;global?:FlagValue}
export interface FlagSnapshot{product:string;environment:string;flags:Record<string,FlagSnapshotEntry>}

export function createFlagReader({declared,environment,snapshot}:{
 declared:Readonly<Record<string,FlagValue>>;
 environment:string;
 /** Returns the latest accepted snapshot, or null. May throw; treated as null. */
 snapshot?:()=>FlagSnapshot|null;
}){
 if(!declared||typeof declared!=='object'||Object.keys(declared).length===0)
  throw new TypeError('declared flag defaults required');
 for(const [k,v] of Object.entries(declared)){
  if(!/^[a-z][a-z0-9_.]{0,99}$/.test(k))throw new TypeError(`invalid flag name ${k}`);
  if(!['boolean','number','string'].includes(typeof v))throw new TypeError(`flag ${k} default must be scalar`);
 }
 if(typeof environment!=='string'||environment.length===0)throw new TypeError('environment required');
 function fromSnapshot(name:string):FlagValue|undefined{
  let s:FlagSnapshot|null=null;
  try{s=snapshot?snapshot():null}catch{return undefined}
  if(!s||s.product!==FLAG_PRODUCT||s.environment!==environment)return undefined;
  const e=Object.prototype.hasOwnProperty.call(s.flags,name)?s.flags[name]:undefined;
  if(!e)return undefined;
  for(const layer of ['organisation','rollout','global'] as const){
   const v=e[layer];
   if(v!==undefined&&typeof v===typeof declared[name])return v;
  }
  return undefined;
 }
 return {
  read(name:string):FlagValue{
   if(!Object.prototype.hasOwnProperty.call(declared,name))throw new Error(`unknown flag ${name}`);
   const v=fromSnapshot(name);
   return v===undefined?declared[name]:v;
  },
 };
}
