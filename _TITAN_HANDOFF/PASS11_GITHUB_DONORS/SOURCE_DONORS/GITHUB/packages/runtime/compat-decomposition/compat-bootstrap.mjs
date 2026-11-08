import {createLazySurfaceLoader} from '../performance/lazy-surface-loader.mjs';

export const COMPAT_BOOTSTRAP_SCHEMA='titan.zero.compat-bootstrap.v1';

const DEFAULT_FEATURES=Object.freeze({
  translation:Object.freeze({kind:'module',path:'../compat-decomposition/chunks/translation.mjs',startup_required:false,company_scoped:false}),
  documentEvidence:Object.freeze({kind:'module',path:'../compat-decomposition/chunks/document-evidence.mjs',startup_required:false,company_scoped:true}),
  browserSession:Object.freeze({kind:'module',path:'../compat-decomposition/chunks/browser-session.mjs',startup_required:false,company_scoped:true}),
  typedAdapter:Object.freeze({kind:'module',path:'../compat-decomposition/chunks/typed-adapter.mjs',startup_required:false,company_scoped:true})
});

function cleanFeature(value){
  const feature=String(value||'').trim();
  if(!feature) throw new Error('compat_feature_required');
  return feature;
}

export function createCompatBootstrap({
  registry=DEFAULT_FEATURES,
  moduleLoader,
  resolveUrl,
  auditSink=()=>{},
  eventTarget=globalThis,
  globalTarget=globalThis
}={}){
  const loader=createLazySurfaceLoader({registry,moduleLoader,resolveUrl,auditSink});
  const listeners=new Map();
  let installed=false;

  function describe(feature){ return loader.describe(cleanFeature(feature)); }
  async function load(feature,input={}){
    const name=cleanFeature(feature);
    const result=await loader.load({surface:name,...input});
    return Object.freeze({schema:COMPAT_BOOTSTRAP_SCHEMA,feature:name,...result});
  }
  function registerEvent(feature,eventName,{input=()=>({}),onLoaded=()=>{}}={}){
    const name=cleanFeature(feature); const event=String(eventName||'').trim();
    if(!event) throw new Error('compat_event_required');
    if(listeners.has(event)) return false;
    const handler=async detail=>{
      try{ const result=await load(name,input(detail)); onLoaded(result,detail); }
      catch(error){ auditSink({schema:COMPAT_BOOTSTRAP_SCHEMA,action:'event-load',feature:name,event,outcome:'failed',authority_neutral:true,error:String(error?.message||error)}); }
    };
    eventTarget?.addEventListener?.(event,handler); listeners.set(event,handler); return true;
  }
  function install(){
    if(installed) return api;
    installed=true;
    if(globalTarget && typeof globalTarget==='object') globalTarget.TitanCompatBootstrap=api;
    return api;
  }
  function uninstall(){
    for(const [event,handler] of listeners) eventTarget?.removeEventListener?.(event,handler);
    listeners.clear();
    if(globalTarget?.TitanCompatBootstrap===api) delete globalTarget.TitanCompatBootstrap;
    installed=false;
  }
  const loadTranslation=input=>load('translation',input);
  const loadDocumentEvidence=input=>load('documentEvidence',input);
  const loadBrowserSession=input=>load('browserSession',input);
  const loadTypedAdapter=input=>load('typedAdapter',input);
  const api=Object.freeze({schema:COMPAT_BOOTSTRAP_SCHEMA,install,uninstall,describe,load,loadTranslation,loadDocumentEvidence,loadBrowserSession,loadTypedAdapter,registerEvent,list:loader.list,isInstalled:()=>installed});
  return api;
}
