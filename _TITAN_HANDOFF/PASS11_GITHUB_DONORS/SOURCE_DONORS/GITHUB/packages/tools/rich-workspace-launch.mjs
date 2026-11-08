export function buildRichWorkspaceUrl(route) {
  if (!route || route.owner !== 'titan-zero' || route.surface !== 'ai_workspace') {
    throw new Error('Invalid Titan AI workspace route');
  }
  const tab = String(route.workspace_tab || '').trim();
  const action = String(route.workspace_action || '').trim();
  if (!tab || !action) throw new Error('Titan AI workspace route missing tab/action');
  const params = new URLSearchParams({tab, action, source:'titan-tools'});
  if (route.document_mode) params.set('document', String(route.document_mode));
  if (route.analysis_mode) params.set('analysis', String(route.analysis_mode));
  if (route.media_mode) params.set('media', String(route.media_mode));
  if (Array.isArray(route.accepted_extensions) && route.accepted_extensions.length) params.set('accept', route.accepted_extensions.join(','));
  return `chatTab.html?${params.toString()}`;
}

export function createAiWorkspaceAdapter({openUrl}={}) {
  if (typeof openUrl !== 'function') throw new Error('Titan AI workspace openUrl adapter required');
  return async route => {
    const url = buildRichWorkspaceUrl(route);
    const result = await openUrl(url);
    return {ok: result?.ok !== false, tool_id: route.tool_id, url, result: result ?? null};
  };
}
