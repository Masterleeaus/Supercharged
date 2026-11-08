# Customize step: browser checks

Manual browser checks for `customize.tsx`. Run them on the wizard at `/app/chatbot-builder/wizard/:id?step=customize`, once with a saved chatbot and once with a new one.

The live preview is a schematic render. It is not the core widget, and it shows placeholder title and welcome text, because those fields live in the Configure step.

Backend state when these checks run: the builder routes are pending. Expect uploads and the avatar list to fail with an error until `builder-routes` is deployed. Checks that need the routes are marked **[needs builder routes]**.

## Setup

1. Sign in, open the chatbot list, and open or create a chatbot.
2. Go to step 2, Customize.
3. Open the browser console and the Network tab. Watch for failed requests.

## 1. Controls update the preview

| # | Control | Action | Expected preview change |
|---|---|---|---|
| 1.1 | Accent swatch | Click a preset swatch | Trigger and user bubble take the swatch colour. The swatch shows `aria-checked="true"`. |
| 1.2 | Custom colour text | Type `#12AB34` | Trigger and user bubble change to `#12AB34`. |
| 1.3 | Custom colour picker | Use the native picker to pick another colour | Text box shows the same hex, and the preview changes. |
| 1.4 | Header background, solid | Choose Solid colour, type `#1E3A8A` | Header background becomes `#1E3A8A`. |
| 1.5 | Header background, gradient | Choose Gradient | Header shows the default gradient, `linear-gradient(90deg, #3B82F6 0%, #8B5CF6 100%)`. |
| 1.6 | Gradient angle | Set the angle to 45 | Header gradient angle changes to 45deg. |
| 1.7 | Gradient type | Choose Radial gradient | Header becomes `radial-gradient(circle, ...)`. The angle field and dial are disabled. |
| 1.8 | Gradient stops | Use the stop colour and position fields | Header gradient follows each change. |
| 1.9 | Header background, image | Choose Image, then pick a file | Preview shows the picked image. See section 3 for upload. |
| 1.10 | Trigger size | Drag the slider from 60 to 80 | Trigger grows to 80px. The label shows `80px`. |
| 1.11 | Transparent trigger | Turn on Transparent trigger | Trigger background becomes transparent, and the icon takes the accent colour. |
| 1.12 | Position | Choose Left, then Right | Preview moves the bubble and window to the chosen side. |
| 1.13 | Show logo | Turn off Show logo, with a logo set | Logo disappears from the header. |
| 1.14 | Show date and time | Turn on | "Today, 10:42" appears in the conversation area. |
| 1.15 | Enable emoji | Turn on | Smiley icon appears in the input bar. |
| 1.16 | Email collect | Turn on | "Email address" bubble appears. |
| 1.17 | Links in welcome screen | Turn on, with at least one social link set | Link chips appear. |
| 1.18 | Links in first assistant message | Turn on, with at least one social link set | Link chips appear, as in 1.17. |
| 1.19 | Contact us | Turn on | "Contact us" button appears. |
| 1.20 | Help center | Turn on | "Help center" button appears. |
| 1.21 | Show GDPR | Turn on | GDPR notice appears. Privacy policy and terms fields appear in Links. |
| 1.22 | Footer link | Type `https://example.com` | Footer text shows the link. |

Each row should change the preview on the same render, with no reload.

## 2. Invalid colours are rejected

| # | Field | Input | Expected |
|---|---|---|---|
| 2.1 | Custom colour | `#abc` (3 digits) | Error: "Use six hex digits such as #017BE5." Preview unchanged. `aria-invalid="true"`. |
| 2.2 | Custom colour | `#GGGGGG` | Same error. Preview unchanged. |
| 2.3 | Custom colour | `017BE5` (no #) | Same error. |
| 2.4 | Custom colour | Type `#abc`, then click outside the box | Text returns to the last saved value and the error clears. |
| 2.5 | Header colour | Empty text | Accepted. Saved value becomes empty (no header colour). Preview header has no background. |
| 2.6 | Header colour | `#GG0000` | Error: "Use six hex digits such as #017BE5, or leave it empty." |
| 2.7 | Gradient stop colour | `red` | Error. The stop keeps its last valid colour. |
| 2.8 | Gradient angle | `361`, or `-1` | Ignored. The field keeps its last valid value. |
| 2.9 | Gradient stop position | `101` | Ignored. The stop keeps its last valid position. |
| 2.10 | Gradient stops | Click "Add a colour stop" until 8 stops | Button disables at 8. |
| 2.11 | Gradient stops | Remove stops until 2 remain | Remove buttons hide at 2. |

## 3. Links

| # | Field | Input | Expected |
|---|---|---|---|
| 3.1 | Any link | `example.com` | Error: "Use a full link that starts with https:// or http://." |
| 3.2 | Any link | `ftp://example.com` | Same error. |
| 3.3 | Any link | `https://wa.me/15551234567` | Accepted. |
| 3.4 | Any link | Clear the field | Accepted. Saved value becomes empty. |
| 3.5 | Any link | 2,049 characters | Error: "Use 2048 characters or fewer." |
| 3.6 | Privacy policy and terms | Show GDPR is off | Both fields are hidden. |

## 4. Uploads

### 4a. No saved chatbot yet

| # | Check | Expected |
|---|---|---|
| 4a.1 | On a new chatbot, open Customize | Logo, welcome background, and header image file inputs are disabled. The hint "Save the chatbot first to upload images." shows. |
| 4a.2 | Avatar upload button | Stays enabled. Avatar upload does not need a saved chatbot. |

### 4b. Valid file, saved chatbot **[needs builder routes]**

| # | Check | Expected |
|---|---|---|
| 4b.1 | Pick a PNG under 4 MB for the logo | Preview shows the picked image. An "Upload" button appears. The status says "Not uploaded yet." |
| 4b.2 | Click Upload | Button shows "Uploading...". Status says "Upload pending (backend: builder routes)." Preview is dimmed. |
| 4b.3 | Server returns success | Preview shows the saved path. Status says "Image set. It is saved with the next save." The shell shows "Unsaved changes". |
| 4b.4 | Server returns an error (routes not deployed) | Red text: "Upload failed: ... The upload endpoint is backend pending." Saved value is unchanged. The picked file stays so the user can retry. |
| 4b.5 | Repeat 4b.1 to 4b.4 for welcome background and header image | Same behaviour, each updating its own field. |

### 4c. Invalid file

| # | Input | Expected |
|---|---|---|
| 4c.1 | A PDF | "Choose an image file." No upload request is made. |
| 4c.2 | A PNG over 4 MB | "Image must be 4 MB or smaller." No upload request is made. |

### 4d. Avatar

| # | Check | Expected |
|---|---|---|
| 4d.1 | Open Customize with the avatar endpoint missing **[needs builder routes]** | Red text: "Avatar presets are not available yet (...). Backend pending: builder routes." The upload button still works. |
| 4d.2 | Avatar endpoint available | Presets load as round thumbnails. Clicking one sets `aria-checked="true"` and updates the preview avatar. |
| 4d.3 | Upload a custom avatar **[needs builder routes]** | Button shows a spinner. Status says "Uploading avatar. Upload pending (backend: builder routes)." On success the new avatar is selected and the list refreshes. On failure the red text shows the error. |
| 4d.4 | Pick a non-image file for an avatar | "Choose an image file." No request is made. |

## 5. Save success and failure

Save uses the shell's `saveNow`. The step's button and the shell's Save and Next all save the same groups.

| # | Scenario | Expected |
|---|---|---|
| 5.1 | Change the accent colour, click "Save this step" | Button shows "Saving...", and is disabled. Then "Saved." appears. The shell's "Unsaved changes" badge clears. |
| 5.2 | Make the PATCH fail (for example, block `PATCH /api/chatbot/builder/:id` in DevTools) and click "Save this step" | Button returns to enabled. Text shows "Not saved. The error is shown above the steps." The shell shows the error alert at the top. The change stays in the draft. |
| 5.3 | Save with no changes | "Saved." appears. No PATCH request is sent for unchanged groups. |
| 5.4 | Save with an invalid value in the draft | Not reachable from the UI, because invalid values are never committed. Confirm that the Network tab shows no request with a bad hex or link. |
| 5.5 | New chatbot, click "Save this step" | Shell creates the chatbot and redirects to `?step=customize` with the id. Uploads are enabled after the redirect. |

## 6. Draft and external updates

| # | Check | Expected |
|---|---|---|
| 6.1 | Change the accent colour, reload the page | The shell restores the draft with its notice. The accent colour is still the changed one. |
| 6.2 | In the restored draft, click Discard | Preview returns to the saved values. Colour text box resets. |
| 6.3 | Type `#abc` in the custom colour field, then discard | Error clears, and the text box shows the saved value. |
| 6.4 | Gradient editor, then Discard | Gradient editor shows the saved gradient, or the default if nothing is saved. |

## 7. Keyboard and accessibility

| # | Check | Expected |
|---|---|---|
| 7.1 | Tab to a gradient stop handle, press Right or Up | Stop moves by 1%. |
| 7.2 | Tab through toggles | Each switch is focusable and labelled. |
| 7.3 | Avatar swatches | Each has an `aria-label` and `aria-checked`. |
| 7.4 | Invalid colour | The error text is linked from the input with `aria-describedby`. |

## Notes for the reviewer

- The Blade has no contrast checks. None are implemented, so there is no check to test. See DECISIONS.md.
- The preview does not show the real title or welcome text. Those are in the Configure step.
- Promo banner and suggested prompts are in the Configure step in the contract, so they are not tested here.
