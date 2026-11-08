const fs = require('fs');
const filePath = 'c:/nodejs_backend/agentlab_v2/agentlabs/server/routes/webhook-routes.ts';
let content = fs.readFileSync(filePath, 'utf8');

const marker = '              // Pre-call credit balance check for existing SIP calls';

const injection = [
  '              // ─────────────────────────────────────────────────────────────────────',
  "              // FIX BUG 1: Close out the pre-created 'calls' table campaign record.",
  "              // Campaign executor pre-creates rows in 'calls' with telephonyProvider=",
  "              // 'elevenlabs-sip'. The webhook writes to 'sip_calls' only -- so those",
  "              // campaign call rows stay 'pending' forever without this fix.",
  '              // FIX BUG 2: Trigger CRM lead from campaign call so it appears in leads.',
  '              // ─────────────────────────────────────────────────────────────────────',
  '              try {',
  '                const targetPhoneSip = resolvedToNumber || calledNumber || resolvedFromNumber || callerPhoneNumber;',
  '                if (targetPhoneSip && existingSipCall.user_id) {',
  '                  const normalizePhoneSip = (p) => p.replace(/[^\\d]/g, \'\');',
  '                  const normalizedTargetSip = normalizePhoneSip(targetPhoneSip);',
  '                  const candidateSipCalls = await db',
  '                    .select()',
  '                    .from(calls)',
  '                    .where(',
  '                      and(',
  '                        eq(calls.userId, existingSipCall.user_id),',
  '                        eq(calls.callDirection, \'outgoing\'),',
  "                        inArray(calls.status, ['pending', 'ringing', 'initiated', 'queued', 'in_progress', 'in-progress']),",
  "                        sql`(${calls.metadata}->>'telephonyProvider') = 'elevenlabs-sip'`",
  '                      )',
  '                    )',
  '                    .orderBy(sql`${calls.createdAt} DESC`)',
  '                    .limit(20);',
  '                  const pendingCampaignCall = candidateSipCalls.find((r) => {',
  '                    const phone = r.toNumber || r.phoneNumber || \'\';',
  '                    const norm = normalizePhoneSip(phone);',
  '                    return norm === normalizedTargetSip || norm.endsWith(normalizedTargetSip) || normalizedTargetSip.endsWith(norm);',
  '                  }) || null;',
  '                  if (pendingCampaignCall) {',
  '                    const sipCloseMeta = JSON.stringify({ sipCallId: existingSipCall.id, elevenLabsConversationId: conversation_id, resolvedAt: new Date().toISOString() });',
  '                    await db',
  '                      .update(calls)',
  '                      .set({',
  '                        status: finalStatus,',
  '                        elevenLabsConversationId: conversation_id,',
  '                        duration: resolvedDuration || null,',
  '                        transcript: syncedData.transcript || null,',
  '                        aiSummary: syncedData.aiSummary || null,',
  '                        classification: syncedData.classification || null,',
  '                        sentiment: syncedData.sentiment || null,',
  '                        recordingUrl: syncedData.recordingUrl || null,',
  '                        startedAt: startedAt,',
  '                        endedAt: endedAt,',
  '                        metadata: sql`COALESCE(${calls.metadata}, \'{}\'::jsonb) || ${sipCloseMeta}::jsonb`,',
  '                      })',
  '                      .where(eq(calls.id, pendingCampaignCall.id));',
  "                    console.log('[ElevenLabs SIP] Closed pre-created campaign call ' + pendingCampaignCall.id + ' -> ' + finalStatus);",
  "                    import('../engines/crm/lead-processor.service').then(({ CRMLeadProcessor }) => {",
  '                      CRMLeadProcessor.processElevenLabsTwilioCall(pendingCampaignCall.id)',
  '                        .then((result) => {',
  "                          if (result && result.leadId) console.log('[CRM] Lead created from SIP campaign call ' + pendingCampaignCall.id + ': ' + result.leadId);",
  "                          else console.log('[CRM] SIP campaign call ' + pendingCampaignCall.id + ' did not qualify for lead');",
  '                        })',
  "                        .catch((err) => console.error('[CRM] Error processing SIP campaign call:', err.message));",
  "                    }).catch((err) => console.error('[CRM] Failed to import lead processor:', err.message));",
  '                  } else {',
  "                    console.log('[ElevenLabs SIP] No matching pending campaign call found for phone ' + targetPhoneSip);",
  '                  }',
  '                }',
  '              } catch (pendingCallCloseErr) {',
  "                console.warn('[ElevenLabs SIP] Failed to close pending campaign call (non-fatal):', pendingCallCloseErr.message);",
  '              }',
  '',
].join('\r\n');

if (content.includes(marker)) {
  const newContent = content.replace(marker, injection + marker);
  fs.writeFileSync(filePath, newContent, 'utf8');
  console.log('SUCCESS: Fix injected into webhook-routes.ts');
} else {
  console.log('MARKER NOT FOUND - check the marker string');
}
