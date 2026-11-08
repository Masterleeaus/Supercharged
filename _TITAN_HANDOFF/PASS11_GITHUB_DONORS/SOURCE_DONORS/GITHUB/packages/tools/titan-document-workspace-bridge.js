(()=>{
  const params=new URLSearchParams(location.search);
  const mode=String(params.get('document')||'').trim();
  if(!mode) return;
  const action=String(params.get('action')||'document-chat').trim();
  const accepted=String(params.get('accept')||'pdf,doc,docx,xls,xlsx,txt,csv,ppt,pptx,png,jpg,jpeg,webp')
    .split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
  const context={mode,action,accepted_extensions:accepted,source:'titan-tools',openedAt:Date.now()};
  document.documentElement.dataset.titanDocumentMode=mode;
  try{chrome.storage?.local?.set?.({titanDocumentLaunchContext:context});}catch(_){ }
  try{window.dispatchEvent(new CustomEvent('titan:document-mode',{detail:context}));}catch(_){ }

  const mimeByExt={pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',txt:'text/plain',csv:'text/csv',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'};
  const enhance=()=>{
    const inputs=[...document.querySelectorAll('input[type="file"]')];
    for(const input of inputs){
      input.dataset.titanDocumentInput='true';
      if(!input.getAttribute('accept')) input.setAttribute('accept',accepted.map(ext=>mimeByExt[ext]||`.${ext}`).join(','));
    }
    const candidates=[...document.querySelectorAll('button,[role="button"],[aria-label],[title]')];
    const upload=candidates.find(el=>/upload|attach|file|document|pdf/i.test(`${el.textContent||''} ${el.getAttribute('aria-label')||''} ${el.getAttribute('title')||''}`));
    if(upload){upload.dataset.titanDocumentLauncher='true'; if(!upload.hasAttribute('tabindex')) upload.setAttribute('tabindex','0');}
    return inputs.length>0 || Boolean(upload);
  };
  if(!enhance()){
    const observer=new MutationObserver(()=>{if(enhance()) observer.disconnect();});
    observer.observe(document.documentElement,{childList:true,subtree:true});
    setTimeout(()=>observer.disconnect(),15000);
  }
})();
