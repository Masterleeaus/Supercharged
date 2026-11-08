/** Safe operational readiness snapshot: no secrets, URLs, user IDs or DB reads. */
export function describeDeskFieldBridgeReadiness({
  forwardEnabled=false, replyEnabled=false,
  forwardPorts, replyPorts, forwardSecret, replySecret,
}={}) {
  const forward=['resolveCompany','verifyConsent','claimEvent','recordResult'].every(k=>typeof forwardPorts?.[k]==='function');
  const reverse=['verifyProviderEvent','resolveFieldContext','classify','submitProposal'].every(k=>typeof replyPorts?.[k]==='function');
  const readyKey=s=>typeof s==='string'&&Buffer.byteLength(s)>=32&&s.trim()===s;
  return Object.freeze({
    mode:'shadow_only',delivery_enabled:false,action_execution_enabled:false,
    forward:{enabled:forwardEnabled===true,ports_ready:forward,key_configured:readyKey(forwardSecret),
      ready:forwardEnabled===true&&forward&&readyKey(forwardSecret)},
    reverse:{enabled:replyEnabled===true,ports_ready:reverse,key_configured:readyKey(replySecret),
      ready:replyEnabled===true&&reverse&&readyKey(replySecret)}
  });
}
