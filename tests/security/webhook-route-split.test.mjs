// Structure checks for the split of server/routes/webhook-routes.ts into server/routes/webhook-modules/ (issue #17).
// The barrel must keep the same public handlers, no module may grow past 800 lines, and the ElevenLabs
// handler must dispatch in the same order as before the split. Static checks on source text, no db is loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODULE_DIR = path.join(ROOT, 'server/routes/webhook-modules');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PUBLIC_HANDLERS = [
  'consumePendingFailure', 'handleIncomingCallWebhook', 'handleTwilioVoiceWebhook', 'handleTwilioStatusWebhook',
  'handleTwilioRecordingWebhook', 'handleTwilioStreamWebSocket', 'handleFlowVoiceAnswer', 'handleFlowNode',
  'handleFlowGather', 'handleFlowContinue', 'handleFlowStatus', 'handleElevenLabsWebhook',
  'fetchElevenLabsConversation', 'getElevenLabsRecording', 'handleAppointmentToolWebhook',
  'handleFormSubmissionWebhook', 'handleRAGToolWebhook', 'handlePlayAudioToolWebhook',
];

test('the webhook barrel exports the same public handlers as before the split', () => {
  const src = read('server/routes/webhook-routes.ts');
  const exported = [...src.matchAll(/export \{([^}]*)\} from/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean))
    .sort();
  assert.deepEqual(exported, [...PUBLIC_HANDLERS].sort());
});

test('no webhook module is over 800 lines', () => {
  for (const file of fs.readdirSync(MODULE_DIR)) {
    const lines = fs.readFileSync(path.join(MODULE_DIR, file), 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= 800, `${file} has ${lines} lines`);
  }
});

test('the ElevenLabs handler dispatches in the same order as before the split', () => {
  const src = read('server/routes/webhook-modules/elevenlabs-webhook.ts');
  const order = [
    "if (type === 'post_call_audio')",
    "if (type === 'call_initiation_failure')",
    'const [callRecord] = await db',
    'await matchCallRecordFallback(ctx);',
    'await updateFlowExecutionToRunning(ctx);',
    'await handleSipCase0(res, ctx, agent)',
    'await handleSipFallback(res, ctx, agent)',
    'await handleCampaignFallbackCreate(res, ctx, agent)',
    'await handleIncomingCallCreate(res, ctx, agent)',
    'await handleFailedCallTracking(res, ctx)',
    'return await processPostCallTranscription(res, ctx)',
  ];
  const at = order.map((s) => {
    const i = src.indexOf(s);
    assert.ok(i >= 0, `${s} not found in the ElevenLabs handler`);
    return i;
  });
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] > at[i - 1], `${order[i]} must come after ${order[i - 1]}`);
  }
});
