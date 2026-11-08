# SEC-04: play-audio tool webhook is unauthenticated

**Source:** Desk `merged3` `server/routes/webhook-routes.ts` `handlePlayAudioToolWebhook` (inventory `:6208-6240`), mounted at `server/routes.ts:1539` as `POST /api/elevenlabs/tools/play-audio/:agentId`.

## Finding
The handler reads `audioUrl` from the body and acts on it (it calls Twilio to play audio on the active call). It has no authentication. Anyone who knows an agent id can trigger playback on that agent's live call. The body is also logged before any check.

## Fix
- Requires an HMAC over the raw body before anything is read or logged. It uses the same `t=<unix>,v0=<hmac>` scheme and helper as SEC-02 (`server/services/elevenlabs-webhook-signature.ts`), keyed with `ELEVENLABS_TOOL_HMAC_SECRET` and sent in header `x-titan-tool-signature`.
- Fail closed: if `ELEVENLABS_TOOL_HMAC_SECRET` is unset, or the signature is missing, stale or wrong, the handler returns 401 and plays nothing.
- `audioUrl` must be an `https://` URL (400 otherwise). This is a small extra check; the inventory noted there is no allowlist.

## Dependency
Apply **SEC-02 first**. This patch imports the helper that SEC-02 adds. Both patches touch `webhook-routes.ts` and this diff is generated against the SEC-02 result.

## Patch
`fix.diff` (against the tree with SEC-02 applied). Edits `webhook-routes.ts` (CRLF preserved) and adds the test.

## Test
`test/play-audio-hmac.test.mjs`. Run `node --test tests/security/play-audio-hmac.test.mjs` after SEC-02 and SEC-04.
- Before this patch: 3 of 7 fail. These are the handler checks (HMAC present, auth before logging, 401 and https rule). The other 4 pass because they test the SEC-02 helper, which is already in the base.
- After this patch: 7 of 7 pass.

## Blocker and decisions for review
1. **ElevenLabs cannot compute a per-request HMAC for a server tool.** The tool config in `server/services/play-audio-elevenlabs-tool.ts:82-87` sends only `Content-Type`. A static header value is not an HMAC over the body. Before this ships, choose one:
   - (a) A signing proxy in front of the tool, or
   - (b) A static shared-secret header compared in constant time. This is weaker against replay but is what ElevenLabs can send.
   I implemented HMAC as specified and did not change the tool config. Until one of these is in place, play-audio will return 401 and audio will not play.
2. Chose https-only for `audioUrl` as an extra guard. Remove it if http sources are needed.

## Residual risk
Replay is possible inside the 30-minute window. There is no allowlist for audio hosts beyond https.
