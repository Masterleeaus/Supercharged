# Channel step: browser checks

Covers `client/src/pages/chatbot-builder/steps/channel.tsx`. Run in the browser after the wizard opens at `/app/chatbot-builder/wizard/<id>?step=channel`.

Setup for the checks: a saved chatbot, a signed-in admin, and the browser devtools Network tab open.

## 1. The step is hidden while the flag is off

Starting state: `CHANNEL_STEP_ENABLED = false` in `channel.tsx`, and `enabled: false` on the channel entry in `steps.ts`.

- [ ] The step bar does not show a "Channel" step. The shell filters on `enabled !== false`.
- [ ] Opening `/app/chatbot-builder/wizard/<id>?step=channel` falls back to the first step (Configure). The channel step does not render.
- [ ] Even when `steps.ts` says `enabled: true` and the flag is still `false`, the step body is empty: no heading, no cards, no alert. Only the step bar label shows. This state is a bug to report, not a success.
- [ ] No request to a channel route appears in the Network tab while the step is hidden.

## 2. The step is visible once the owner flips both lines

Starting state: both lines changed as in DECISIONS.md.

- [ ] The step bar shows "Channel" after "Test and embed".
- [ ] The heading "Channels" shows, followed by the pending notice and the Website row.
- [ ] Four channel cards show: Telegram, WhatsApp, Messenger, Instagram. Each shows "Not connected".

## 3. Secrets are masked and never sent back in full

Fields to check: Telegram "Bot token", WhatsApp "Account SID" and "Auth token", Messenger "App secret" and "Webhook verify token".

- [ ] Each secret field is a password input (dots, not text), with `autocomplete` set to `new-password`. The browser does not offer to autofill a saved password.
- [ ] On first load, no secret field has a value. Inspect the DOM: the `value` attribute is empty.
- [ ] Type `abc123` into "Bot token", then reload the page. The field is empty again, and the value does not appear in the page source or in Network responses.
- [ ] When the server reports a saved secret (the owner sees this once the channel loader is built), the field shows the placeholder dots, is read-only and disabled, and has a "Replace" button. The DOM has no value and no partial value (no last-four characters).
- [ ] Clicking "Replace" makes the field editable and empty. The stored value is not copied into it.
- [ ] Open the Network tab, type a Telegram token, then click "Connect". No request leaves the page, because the channel service is a stub. Checking this now confirms that nothing is sent early.
- [ ] Once the channel service exists, repeat the check: the body contains only the typed, non-empty values in `credentials`. A secret field left empty is not in the body. Clearing a typed token removes its key from the body.
- [ ] Check the browser's localStorage for keys starting with `chatbot-wizard-draft:`. No token, SID, secret or verify token appears in any draft value. Secrets are kept in component state only.

## 4. Every external action shows a pending state

Actions: "Connect" (or "Sign in with Instagram") and "Send test message" on each of the four channels. Each action must be checked on each channel.

- [ ] Click "Connect" on Telegram. The button text changes to "Connect (pending)" and is disabled. A "Pending" badge appears on the card. The notice reads that nothing was sent to the provider.
- [ ] Click "Send test message" on Telegram. Its button text changes to "(pending)" and is disabled. The notice reads that no test message was sent.
- [ ] Repeat both actions on WhatsApp, Messenger and Instagram. Each shows the same pending states.
- [ ] While pending, all inputs on that card are disabled, so a typed value cannot change mid-action.
- [ ] Network tab: during each action no request goes to `api.telegram.org`, `api.twilio.com`, `graph.facebook.com`, `api.instagram.com` or any other provider host. No request goes to a `/api/chatbot/builder/.../channels` route, because none exists yet.
- [ ] The switch "Enable <channel>" stays disabled on every card, because no channel can be connected yet.

## 5. Disabled and unsaved states

- [ ] Open the step on an unsaved chatbot (the create flow). The alert "Save the chatbot first" shows. Every card's Connect and Send test message buttons are disabled.
- [ ] While a save is running (`disabled` prop true), every input and button on the step is disabled.

## 6. Visual and accessibility

- [ ] The card layout fits an iPad-width viewport (about 820 px) with no horizontal scroll.
- [ ] Tab order follows the card order: field, then Connect, then Send test message, then the next card.
- [ ] The switch has the label "Enable <channel>".
- [ ] The notice text uses `role="status"`, so a screen reader announces the pending result.
- [ ] The masked-field helper text is available to screen readers through the visually hidden span.
