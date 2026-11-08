const AI_WORKSPACE = new Set([
  'write','rewrite','grammar','translate','summarize','read','search','chatpdf','youtube_assistant','mindmap','ai_detector','humanize','podcast','audio_to_text','image_generate','image_edit','image_realtime','image_restore_transform','video_generate','text_to_video','image_to_video','attachments','model_selection','prompts_skills'
]);

const PAGE_CONTEXT = new Set([
  'webpage_assistant','full_page','text_selection','floating_assistant','screenshots'
]);

const RETRIEVER_CAPABILITY = {
  browser_actions:'browser_actions',
  crawl_extract:'crawl_extract',
  structured_data:'structured_data',
  sheets:'sheets',
  pdf_generate_fill:'pdf',
  docs_slides_web:'docs_slides_web',
  custom_tools:'custom_tools',
  multi_tool:'multi_tool',
  schedules:'schedules',
  triggers:'triggers',
};

const LANGUAGE_WORKSPACE = {
  write:['write','write'], rewrite:['write','rewrite'], grammar:['write','grammar'],
  translate:['translate','translate'], summarize:['reading','summarize'], read:['reading','read'], search:['search','search'],
};

const DOCUMENT_WORKSPACE = {
  chatpdf:{tab:'chat', action:'document-chat', mode:'chatpdf'},
  attachments:{tab:'chat', action:'attachments', mode:'files'},
};

const ANALYSIS_WORKSPACE = {
  mindmap:{tab:'tools', action:'mindmap', mode:'mindmap'},
  ai_detector:{tab:'tools', action:'ai-detector', mode:'ai-detector'},
  humanize:{tab:'tools', action:'humanize', mode:'humanize'},
};

const MEDIA_WORKSPACE = {
  podcast:{tab:'audio', action:'podcast', mode:'podcast'},
  audio_to_text:{tab:'audio', action:'audio-to-text', mode:'audio-to-text'},
  image_generate:{tab:'image', action:'image-generate', mode:'image-generate'},
  image_edit:{tab:'image', action:'image-edit', mode:'image-edit'},
  image_realtime:{tab:'image', action:'image-realtime', mode:'image-realtime'},
  image_restore_transform:{tab:'image', action:'image-transform', mode:'image-transform'},
  video_generate:{tab:'video', action:'video-generate', mode:'video-generate'},
  text_to_video:{tab:'video', action:'text-to-video', mode:'text-to-video'},
  image_to_video:{tab:'video', action:'image-to-video', mode:'image-to-video'},
};
const UTILITY_WORKSPACE = {
  youtube_assistant:{tab:'reading', action:'youtube'},
  model_selection:{tab:'chat', action:'models'},
  prompts_skills:{tab:'toolkit', action:'prompts-skills'},
};
const DOCUMENT_EXTENSIONS = ['pdf','doc','docx','xls','xlsx','txt','csv','ppt','pptx','png','jpg','jpeg','webp'];

const AI_ACTIONS = {
  write:'open:write', rewrite:'open:rewrite', grammar:'open:grammar', translate:'open:translate',
  summarize:'open:summarize', read:'open:read', search:'open:search', chatpdf:'open:chatpdf',
  youtube_assistant:'open:youtube', mindmap:'open:mindmap', ai_detector:'open:ai-detector',
  humanize:'open:humanize', podcast:'open:podcast', audio_to_text:'open:audio-to-text',
  image_generate:'open:image-generate', image_edit:'open:image-edit', image_realtime:'open:image-realtime',
  image_restore_transform:'open:image-transform', video_generate:'open:video-generate',
  text_to_video:'open:text-to-video', image_to_video:'open:image-to-video', attachments:'open:attachments',
  model_selection:'open:models', prompts_skills:'open:prompts-skills',
};

const PAGE_ACTIONS = {
  webpage_assistant:'page:assist', full_page:'page:full-assist', text_selection:'selection:assist',
  floating_assistant:'page:floating-assist', screenshots:'page:capture',
};

function routeForTool(tool) {
  const id = String(tool?.tool_id || tool?.id || '').trim();
  if (AI_WORKSPACE.has(id)) {
    const language = LANGUAGE_WORKSPACE[id];
    const documentWorkspace = DOCUMENT_WORKSPACE[id];
    const analysisWorkspace = ANALYSIS_WORKSPACE[id];
    const mediaWorkspace = MEDIA_WORKSPACE[id];
    const utilityWorkspace = UTILITY_WORKSPACE[id];
    const route = {
      tool_id:id,
      owner:'titan-zero',
      surface:'ai_workspace',
      entrypoint:'chatTab.html',
      action:AI_ACTIONS[id] || `open:${id}`,
      launch_contract:'titan-tool-launch/v1',
      donor_navigation:false,
    };
    if (language) {
      route.workspace_tab = language[0];
      route.workspace_action = language[1];
      route.launch_url = `chatTab.html?tab=${encodeURIComponent(language[0])}&action=${encodeURIComponent(language[1])}&source=titan-tools`;
    }
    if (analysisWorkspace) {
      route.workspace_tab = analysisWorkspace.tab;
      route.workspace_action = analysisWorkspace.action;
      route.analysis_mode = analysisWorkspace.mode;
      const params = new URLSearchParams({tab:analysisWorkspace.tab, action:analysisWorkspace.action, analysis:analysisWorkspace.mode, source:'titan-tools'});
      route.launch_url = `chatTab.html?${params.toString()}`;
    }
    if (mediaWorkspace) {
      route.workspace_tab = mediaWorkspace.tab;
      route.workspace_action = mediaWorkspace.action;
      route.media_mode = mediaWorkspace.mode;
      const params = new URLSearchParams({tab:mediaWorkspace.tab, action:mediaWorkspace.action, media:mediaWorkspace.mode, source:'titan-tools'});
      route.launch_url = `chatTab.html?${params.toString()}`;
    }
    if (utilityWorkspace) {
      route.workspace_tab = utilityWorkspace.tab;
      route.workspace_action = utilityWorkspace.action;
      const params = new URLSearchParams({tab:utilityWorkspace.tab, action:utilityWorkspace.action, source:'titan-tools'});
      route.launch_url = `chatTab.html?${params.toString()}`;
    }
    if (documentWorkspace) {
      route.workspace_tab = documentWorkspace.tab;
      route.workspace_action = documentWorkspace.action;
      route.document_mode = documentWorkspace.mode;
      route.accepted_extensions = [...DOCUMENT_EXTENSIONS];
      const params = new URLSearchParams({tab:documentWorkspace.tab, action:documentWorkspace.action, document:documentWorkspace.mode, source:'titan-tools'});
      params.set('accept', DOCUMENT_EXTENSIONS.join(','));
      route.launch_url = `chatTab.html?${params.toString()}`;
    }
    return route;
  }
  if (PAGE_CONTEXT.has(id)) {
    return {
      tool_id:id,
      owner:'titan-zero',
      surface:'page_context',
      entrypoint:'content-runtime/page-tool.iife.js',
      action:PAGE_ACTIONS[id] || `page:${id}`,
      launch_contract:'titan-tool-launch/v1',
      donor_navigation:false,
    };
  }
  if (RETRIEVER_CAPABILITY[id]) {
    return {
      tool_id:id,
      owner:'titan-zero',
      surface:'retriever_runtime',
      entrypoint:'side-panel/index.html',
      action:'retriever:capability',
      capability_id:RETRIEVER_CAPABILITY[id],
      launch_contract:'titan-tool-launch/v1',
      donor_navigation:false,
      grants_execution_authority:false,
    };
  }
  return null;
}

export function buildTitanToolLaunchMap(tools=[]) {
  const map = {};
  for (const tool of tools) {
    const route = routeForTool(tool);
    if (route) map[route.tool_id] = route;
  }
  return map;
}

export function resolveTitanToolLaunch(toolId, map) {
  const id = String(toolId || '').trim();
  const route = map?.[id];
  if (!route) throw new Error(`Unknown Titan tool: ${id || '(empty)'}`);
  return structuredClone(route);
}

export function validateTitanToolLaunchMap(map, tools=[]) {
  const errors = [];
  const expected = new Set(tools.map(tool => String(tool?.tool_id || tool?.id || '').trim()).filter(Boolean));
  for (const id of expected) {
    const route = map?.[id];
    if (!route) { errors.push(`${id}: no Titan launch route`); continue; }
    if (route.owner !== 'titan-zero') errors.push(`${id}: launch owner must be titan-zero`);
    if (!route.action) errors.push(`${id}: missing launch action`);
    if (!route.entrypoint) errors.push(`${id}: missing Titan entrypoint`);
    const serialized = JSON.stringify(route).toLowerCase();
    if (serialized.includes('monica.im') || serialized.includes('monicapopup.html')) errors.push(`${id}: donor navigation is forbidden`);
    if (route.donor_navigation !== false) errors.push(`${id}: donor_navigation must be false`);
  }
  for (const id of Object.keys(map || {})) if (!expected.has(id)) errors.push(`${id}: route has no census tool`);
  return {ok:errors.length === 0, errors};
}

