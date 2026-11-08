# Train step: browser checks

Covers `client/src/pages/chatbot-builder/steps/train.tsx`. Run in the wizard at `/app/chatbot-builder/wizard/:id?step=train` with a saved chatbot. Use the browser DevTools Network tab to watch requests.

Setup: open an existing chatbot, go to step 3 (Train). Keep the Network tab open. Sources routes are proposed (not in endpoint-map.md yet). Until the owner adds them, expect 404 on the list and save calls. The checks below mark which results are expected now.

## 1. Gate on an unsaved chatbot

- [ ] Open `/app/chatbot-builder/wizard?step=train` without an id. The step should be unreachable from the nav (only step 1 is clickable). If reached by URL, the alert "Save the chatbot first" shows and every input and button is disabled.

## 2. Tabs

- [ ] Four tab buttons in order: Website, PDF, Text, Q&A. Website is selected first.
- [ ] Switching tabs shows that tab's form and only that tab's sources.
- [ ] A field error from one tab does not stay visible after switching tabs.
- [ ] While a save is running, the tab buttons are disabled.

## 3. Website tab: URL validation

Enter each value, press Fetch, and check the message in the red alert. No request should be sent in these cases (check Network).

- [ ] Empty: "Enter a URL."
- [ ] `example.com` (no scheme): "Enter a full URL, starting with https:// or http://."
- [ ] `ftp://example.com`: "The URL must start with http:// or https://."
- [ ] `https://localhost`: "Enter a URL with a domain, for example https://example.com."
- [ ] A valid URL `https://example.com` sends `POST .../sources/website` with `{ url, single: false }`.
- [ ] Choosing "Single URL" sends `single: true`.
- [ ] Pending: the Fetch button reads "Fetching..." and is disabled until the request ends.

## 4. PDF tab: file validation

- [ ] The file picker accepts only `.pdf, .xlsx, .xls, .csv, .txt, .json`.
- [ ] Choosing `image.png` (by bypassing the picker filter, for example with "All files") shows "Choose a file of type PDF, XLSX, XLS, CSV, TXT, JSON." and clears the selection.
- [ ] Choosing an empty `.pdf` shows "This file is empty."
- [ ] Choosing a `.pdf` larger than 25 MB shows "This file is larger than 25 MB."
- [ ] A valid `.pdf` under 25 MB shows "Selected: <name>" and enables Upload.
- [ ] Upload with no file: the button is disabled, so no request is sent.
- [ ] Pending: the button reads "Uploading..." and the picker is disabled during the upload.

## 5. Text tab: required fields

- [ ] Empty title, with text filled: "Title is required."
- [ ] Title filled, empty text: "Text is required."
- [ ] Whitespace only in either field: the same message as empty.
- [ ] Valid entry sends `POST .../sources` with `{ type: "text", title, content }`, trimmed.
- [ ] Pending: the button reads "Saving...".
- [ ] After a successful save: both fields clear, a "Text saved" toast shows, and the new item appears in the Text list with the "Not trained" badge, without a page reload.

## 6. Q&A tab: required fields

- [ ] Empty question: "Question is required."
- [ ] Empty answer: "Answer is required."
- [ ] Valid entry sends `POST .../sources` with `{ type: "qa", title: <question>, content: <answer> }`.
- [ ] After a successful save: both fields clear, a "Q&A saved" toast shows, and the new item appears in the Q&A list without a reload.

## 7. Source list

- [ ] The count in the heading matches the number of rows for the active tab.
- [ ] "Select all" selects every row in the active tab only. Clicking again clears them. The label switches between "Select all" and "Deselect all".
- [ ] The "Train selected sources (N)" button is disabled when N is 0.
- [ ] Delete asks "Delete this source?". Cancel sends no request.

## 8. External actions: not-connected state

Expected now, because the backend is missing:

- [ ] Fetch (Website) with a valid URL: the alert "Training backend not connected in Desk yet" appears, with "Details:" and the error text. The URL field keeps its value.
- [ ] Upload (PDF) with a valid file: the same alert appears. The file stays selected.
- [ ] Train selected sources: the same alert appears. The selection stays.
- [ ] Delete a row, then confirm: the same alert appears, and the row stays in the list.
- [ ] Text and Q&A still save while the alert is showing. The alert does not block them.
- [ ] The alert stays until one external action succeeds, and then it clears.

## 9. Source list refresh after a save

- [ ] Save a text entry, then check the Network tab: a `GET .../sources` request follows the successful `POST`. The new row shows without a reload.
- [ ] Save a Q&A entry in the same session. The Text list does not change, and the Q&A list shows the new row.
- [ ] Reload the page. The saved rows are still there, which shows they were stored on the server and not kept only in the page.

## 10. List load failure

- [ ] With the sources route returning an error, the alert "Could not load sources" appears with a Retry button. Retry sends another `GET`.
- [ ] Forms still render and can be submitted. Saving then shows its own error in the form, and it does not crash the step.

## 11. Browser states

- [ ] Keyboard: Tab moves through the tab buttons, the form fields and the row checkboxes in order. Space toggles checkboxes.
- [ ] Screen reader: each row checkbox has a label. Delete buttons say "Delete <name>".
- [ ] Narrow width (about 380 px): the URL row wraps, and the Fetch button stays inside the card.
- [ ] No console errors on a normal load, other than expected 404s from the proposed routes.
