(()=>{
  'use strict';
  const ROOT_ID='titan-tool-discovery';
  const MAX_RECENT=12;
  const ext = p => globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL(p) : p;
  const text = v => String(v??'').trim();
  const safeCompany = v => text(v||'unscoped').replace(/[^a-zA-Z0-9._-]/g,'_');
  const favKey = id => `titan.tools.favourites.${safeCompany(id)}`;
  const recentKey = id => `titan.tools.recent.${safeCompany(id)}`;
  const localGet = async key => new Promise(resolve => {
    if(!globalThis.chrome?.storage?.local) return resolve(JSON.parse(localStorage.getItem(key)||'null'));
    chrome.storage.local.get([key], r=>resolve(r?.[key]??null));
  });
  const localSet = async (key,value) => new Promise(resolve => {
    if(!globalThis.chrome?.storage?.local){ localStorage.setItem(key,JSON.stringify(value)); return resolve(); }
    chrome.storage.local.set({[key]:value},resolve);
  });
  const getCompanyId = async () => {
    const keys=['company_id','titanCompanyId','activeCompanyId'];
    if(globalThis.chrome?.storage?.local){
      const v=await new Promise(r=>chrome.storage.local.get(keys,r));
      for(const k of keys) if(text(v?.[k])) return text(v[k]);
    }
    return text(document.documentElement.dataset.companyId || 'unscoped');
  };
  const loadJson = async p => (await fetch(ext(p))).json();
  const escapeHtml = s => text(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const detectDiscover = () => {
    const q=new URLSearchParams(location.search);
    if(['discover','toolkit','tools'].includes(text(q.get('tab')).toLowerCase())) return true;
    return [...document.querySelectorAll('h1,h2,[role="heading"],nav,a,button')].some(el=>/^(discover|tools|toolbox)$/i.test(text(el.textContent)) && (el.getAttribute('aria-current')==='page' || el.dataset?.state==='active' || el.className?.toString().match(/active|selected/i)));
  };
  const mountHost = () => document.querySelector('main,[role="main"],#root') || document.body;

  async function launch(item){
    const route=item.launch||{};
    await rememberRecent(item.tool_id);
    if(route.surface==='page_context'){
      return new Promise(resolve=>chrome.runtime.sendMessage({type:'TITAN_TOOL_LAUNCH',tool_id:item.tool_id,source:'tool-discovery'},resolve));
    }
    const url=route.launch_url||route.entrypoint||'chatTab.html';
    location.href=ext(url);
  }
  let company_id='unscoped', favourites=new Set(), recent=[], index=[];
  async function rememberRecent(id){
    recent=[id,...recent.filter(x=>x!==id)].slice(0,MAX_RECENT);
    await localSet(recentKey(company_id),recent);
  }
  async function toggleFavourite(id){
    favourites.has(id)?favourites.delete(id):favourites.add(id);
    await localSet(favKey(company_id),[...favourites]);
    render();
  }
  const categories = () => [...new Set(index.map(x=>x.category))].sort();
  let query='', category='all', view='all';
  function filtered(){
    let rows=index;
    if(view==='favourites') rows=rows.filter(x=>favourites.has(x.tool_id));
    if(view==='recent') rows=recent.map(id=>rows.find(x=>x.tool_id===id)).filter(Boolean);
    if(category!=='all') rows=rows.filter(x=>x.category===category);
    const q=query.toLowerCase().trim();
    if(q) rows=rows.filter(x=>x.searchable.includes(q) || q.split(/\s+/).every(t=>x.searchable.includes(t)));
    return rows;
  }
  function render(){
    const root=document.getElementById(ROOT_ID); if(!root) return;
    const rows=filtered();
    root.innerHTML=`<div class="titan-tools-head"><div><h2>Discover tools</h2><p>${index.length} Titan tools · cleaning-focused discovery · company scoped</p></div><input class="titan-tools-search" type="search" value="${escapeHtml(query)}" placeholder="Search tools, cleaning tasks or roles" aria-label="Search tools"></div>
    <div class="titan-tools-tabs" aria-label="Tool views"><button data-view="all" aria-pressed="${view==='all'}">All</button><button data-view="favourites" aria-pressed="${view==='favourites'}">Favourites</button><button data-view="recent" aria-pressed="${view==='recent'}">Recent</button></div>
    <div class="titan-tools-categories" aria-label="Tool categories"><button data-category="all" aria-pressed="${category==='all'}">All categories</button>${categories().map(c=>`<button data-category="${escapeHtml(c)}" aria-pressed="${category===c}">${escapeHtml(c)}</button>`).join('')}</div>
    <div class="titan-tools-grid">${rows.length?rows.map(item=>`<article class="titan-tool-card" data-titan-tool-id="${escapeHtml(item.tool_id)}"><button class="titan-tool-fav" aria-label="${favourites.has(item.tool_id)?'Remove from':'Add to'} Favourites" aria-pressed="${favourites.has(item.tool_id)}" data-favourite="${escapeHtml(item.tool_id)}">${favourites.has(item.tool_id)?'★':'☆'}</button><h3>${escapeHtml(item.title)}</h3><div class="titan-tool-meta">${escapeHtml(item.category)} · ${escapeHtml(item.cleaning_relevance)} cleaning relevance</div><p>${escapeHtml((item.cleaning_use_cases||[]).slice(0,3).join(' · ') || 'General Titan capability')}</p><button class="titan-tool-open" data-open-tool="${escapeHtml(item.tool_id)}">Open tool</button></article>`).join(''):'<div class="titan-tools-empty">No tools match this view.</div>'}</div>`;
    root.querySelector('.titan-tools-search')?.addEventListener('input',e=>{query=e.target.value;render();root.querySelector('.titan-tools-search')?.focus();});
    root.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;render();}));
    root.querySelectorAll('[data-category]').forEach(b=>b.addEventListener('click',()=>{category=b.dataset.category;render();}));
    root.querySelectorAll('[data-favourite]').forEach(b=>b.addEventListener('click',()=>toggleFavourite(b.dataset.favourite)));
    root.querySelectorAll('[data-open-tool]').forEach(b=>b.addEventListener('click',()=>{const item=index.find(x=>x.tool_id===b.dataset.openTool); if(item) launch(item);}));
  }
  async function mount(){
    if(document.getElementById(ROOT_ID) || !detectDiscover()) return;
    const [registry,map]=await Promise.all([loadJson('titan-tools/TOOL-REGISTRY.json'),loadJson('titan-tools/TOOL-LAUNCH-MAP.json')]);
    company_id=await getCompanyId();
    favourites=new Set((await localGet(favKey(company_id)))||[]);
    recent=(await localGet(recentKey(company_id)))||[];
    const tools=Array.isArray(registry.tools)?registry.tools:Object.values(registry.tools||{});
    index=tools.map(tool=>{const route=map.routes?.[tool.tool_id]||{}; const bits=[tool.tool_id,tool.name,tool.category,tool.cleaning_relevance,...(tool.cleaning_use_cases||[]),...(tool.supported_roles||[])]; return {tool_id:tool.tool_id,title:tool.name||tool.tool_id,category:tool.category||'Other',cleaning_relevance:tool.cleaning_relevance||'general',cleaning_use_cases:tool.cleaning_use_cases||[],surface:route.surface||tool.launch_surface,launch:route,searchable:bits.join(' ').toLowerCase()};});
    const root=document.createElement('section'); root.id=ROOT_ID; root.dataset.companyId=company_id; root.setAttribute('aria-label','Titan tool discovery');
    mountHost().appendChild(root); render();
    window.dispatchEvent(new CustomEvent('titan:tool-discovery-ready',{detail:{company_id,count:index.length}}));
  }
  const observer=new MutationObserver(()=>mount().catch(()=>{}));
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>{mount().catch(()=>{});observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true});},{once:true});
  else { mount().catch(()=>{}); observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true}); }
})();
