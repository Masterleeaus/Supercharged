(()=>{
  const params=new URLSearchParams(location.search);
  const mode=String(params.get('analysis')||'').trim().toLowerCase();
  if(!mode) return;
  const config={
    mindmap:{action:'mindmap',label:/\b(mind\s*map|mindmap)\b/i},
    'ai-detector':{action:'ai-detector',label:/\b(ai\s*(content\s*)?detector|content\s*detector|ai\s*checker)\b/i},
    humanize:{action:'humanize',label:/\b(humani[sz]e|ai\s*humanizer|humanizer)\b/i},
  }[mode];
  if(!config) return;
  const context={mode,action:config.action,source:'titan-tools',openedAt:Date.now()};
  document.documentElement.dataset.titanAnalysisMode=mode;
  try{chrome.storage?.local?.set?.({titanAnalysisLaunchContext:context});}catch(_){ }
  try{window.dispatchEvent(new CustomEvent('titan:analysis-mode',{detail:context}));}catch(_){ }

  let activated=false;
  const textFor=el=>`${el.textContent||''} ${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''}`.replace(/\s+/g,' ').trim();
  const enhance=()=>{
    const candidates=[...document.querySelectorAll('button,a,[role="button"],[data-tool],[aria-label],[title]')];
    const target=candidates.find(el=>config.label.test(textFor(el)));
    if(!target) return false;
    target.dataset.titanAnalysisLauncher=mode;
    if(!target.hasAttribute('tabindex')) target.setAttribute('tabindex','0');
    if(!activated){
      activated=true;
      try{target.click();}catch(_){ }
    }
    return true;
  };
  if(!enhance()){
    const observer=new MutationObserver(()=>{if(enhance()) observer.disconnect();});
    observer.observe(document.documentElement,{childList:true,subtree:true});
    setTimeout(()=>observer.disconnect(),15000);
  }
})();
