# Embed step: browser checks

Covers `client/src/pages/chatbot-builder/steps/embed.tsx`. Open the wizard at `/app/chatbot-builder/wizard/<id>?step=embed` for a saved chatbot that has a public id (`embed.uuid`). Until the builder routes exist, the public id is null and the snippet shows the "not ready" message. Those checks are marked (needs builder routes).

## 1. Snippet contains the chatbot id

1. Open the Test and embed step for a saved chatbot.
2. Read the "Embed code" box.
3. Expected: a `<script defer src="...">` tag whose `data-chatbot-uuid` equals the chatbot's public id (`embed.uuid`). It is not the internal id from the URL.
4. Expected: `data-iframe-width="400"` and `data-iframe-height="600"` at the defaults.
5. Expected: the `src` ends with `/vendor/chatbot/js/external-chatbot.js`. The host matches `VITE_CHATBOT_WIDGET_BASE_URL` when it is set, and the page origin when it is not.
6. Expected: no token, key or secret text appears anywhere in the snippet.
7. Move the Width slider to 800. Expected: `data-iframe-width="800"` and the label shows `800px`. Reload the page. Expected: the value is back at 400 (not saved).
8. (needs builder routes) Open a chatbot with no public id. Expected: no snippet box. The "not ready yet" message shows, and the Copy button is absent.
9. Open an unsaved new chatbot. The step is not reachable (only the first step is). Expected: the wizard's first step is shown instead.

## 2. Copy works

Run in Chrome on `https://` or `localhost` (secure context, Clipboard API present).

1. Click "Copy embed code".
2. Expected: the button label becomes "Copied" and a toast "Embed code copied" appears. The label returns to "Copy embed code" after about 2 seconds.
3. Paste into a plain text field. Expected: the same multi-line snippet, with the same uuid.

## 3. Copy falls back

Use one of these ways to force the fallback:

- Serve the wizard over plain `http://` from a non-localhost hostname (not a secure context, so `navigator.clipboard` is unavailable), or
- In DevTools, run `Object.defineProperty(navigator, 'clipboard', { value: undefined })` and reload.

1. Click "Copy embed code".
2. Expected: the snippet is copied through the hidden textarea and `execCommand`. The "Copied" label and toast appear as in section 2.
3. Paste to confirm the text matches.
4. Force the failure too: in DevTools, run `document.execCommand = () => false` and click Copy again.
5. Expected: the red message "Could not copy automatically. Select the code above and copy it by hand." shows. Clicking inside the "Embed code" box selects all of its text, so it can be copied by hand.

## 4. Inactive warning

1. In the Configure step, turn "Active" off and click Save. Go to Test and embed.
2. Expected: the alert "This chatbot is not active" shows at the top of the step. The warning reads the saved state from the chatbot list.
3. Turn "Active" on, save, return to this step. Expected: the alert is gone.
4. Turn "Active" off without saving, then move to this step. Expected: the alert does not show yet. It reflects the saved state only.

## 5. Trusted domains

1. Type `https://Shop.Example.com/cart, example.com` into "Trusted domains". Expected: the text stays as typed. After Save and reload, the field shows `shop.example.com, example.com`.
2. Type `example.com:8080`. Expected: the red line "Not valid hostnames, so not saved: example.com:8080" shows. Valid entries still save.
3. Type 51 different hostnames. Expected: "Up to 50 domains..." shows. Remove one. Expected: the message clears.
4. Clear the field. Expected: the snippet is unchanged, and the chatbot is not restricted (the helper text says so).

## 6. Install check is pending

1. Find the "Check installation" section.
2. Expected: a disabled button and a "Pending" badge. The text says Desk has no route to check the installation yet (EXTERNAL).
3. Expected: clicking the disabled button does nothing. No network request is made (DevTools Network tab, filter `check`).
4. Expected: no success or failure message appears.

## 7. Disabled state

1. Trigger a save from the shell (the Save button) so the shell is busy.
2. Expected: the domain textarea and both sliders are disabled while the save runs.

## Result log

| Date | Browser | Section | Pass or fail | Notes |
|---|---|---|---|---|
|  |  |  |  |  |
