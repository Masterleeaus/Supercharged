(()=>{
  const params=new URLSearchParams(location.search);
  const mode=String(params.get('media')||'').trim().toLowerCase();
  if(!mode) return;
  const config={
    'image-generate':{labels:[/\b(ai\s*)?image\s*generator\b/i,/\btext\s*to\s*image\b/i]},
    'image-edit':{labels:[/\bimage\s*(edit|editor|to\s*image)\b/i,/\bimage\s*to\s*image\b/i]},
    'image-realtime':{labels:[/\b(real[- ]?time|realtime).*image\b/i,/\blive.*image\b/i]},
    'image-transform':{labels:[/\b(image\s*)?(enhance|upscale|restore|transform)\b/i,/\bremove\s*object\b/i,/\bchange\s*background\b/i]},
    'video-generate':{labels:[/\b(ai\s*)?video\s*generator\b/i,/\bcreate\s*video\b/i]},
    'text-to-video':{labels:[/\btext\s*to\s*video\b/i]},
    'image-to-video':{labels:[/\bimage\s*to\s*video\b/i,/\banimate\s*(an?\s*)?image\b/i]},
    'audio-to-text':{labels:[/\baudio\s*to\s*text\b/i,/\btranscri(be|ption)\b/i]},
    podcast:{labels:[/\b(ai\s*)?podcast\b/i,/\bpodcast\s*generator\b/i]},
  }[mode];
  if(!config) return;
  const tab=String(params.get('tab')||'').trim().toLowerCase();
  const action=String(params.get('action')||mode).trim().toLowerCase();
  const context={mode,tab,action,source:'titan-tools',openedAt:Date.now(),grants_execution_authority:false};
  document.documentElement.dataset.titanMediaMode=mode;
  document.documentElement.setAttribute('data-titan-media-mode',mode);
  try{chrome.storage?.local?.set?.({titanMediaLaunchContext:context});}catch(_){ }
  try{window.dispatchEvent(new CustomEvent('titan:media-mode',{detail:context}));}catch(_){ }

  let activated=false;
  const textFor=el=>`${el.textContent||''} ${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''} ${el.getAttribute?.('data-tool')||''}`.replace(/\s+/g,' ').trim();
  const findTarget=()=>{
    const candidates=[...document.querySelectorAll('button,a,[role="button"],[data-tool],[aria-label],[title]')];
    return candidates.find(el=>config.labels.some(rx=>rx.test(textFor(el))));
  };
  const enhance=()=>{
    const target=findTarget();
    if(!target) return false;
    target.dataset.titanMediaMode=mode;
    target.dataset.titanMediaLauncher='true';
    if(!target.hasAttribute('tabindex')) target.setAttribute('tabindex','0');
    if(!activated){activated=true; try{target.click();}catch(_){ }}
    return true;
  };
  if(!enhance()){
    const observer=new MutationObserver(()=>{if(enhance()) observer.disconnect();});
    observer.observe(document.documentElement,{childList:true,subtree:true});
    setTimeout(()=>observer.disconnect(),15000);
  }
})();
