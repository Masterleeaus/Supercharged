# Configure step: browser test checklist

No React test runner is set up in this project, so these checks are run by hand in a browser. Each item says what to do and what to expect.

Setup:
- Sign in, then open `/app/chatbot-builder/wizard?step=configure` (new chatbot) and `/app/chatbot-builder/wizard/<id>?step=configure` (existing chatbot).
- Backend builder routes may not be live. Where a check needs them, the expected result is noted.

## 1. Loading

- [ ] New chatbot: Chatbot title is empty. Bubble message is empty. Bubble design shows "Blank". Language shows "Auto". Both switches are off. The promo banner row is hidden. The suggested prompts panel is hidden.
- [ ] Existing chatbot: every text field shows its saved value (title, bubble message, welcome message, instructions).
- [ ] Existing chatbot: Bubble design shows the saved design, with these labels: Blank, Plain, Links, Modern, Suggestions, Promo Banner.
- [ ] Existing chatbot: "Do not go beyond instructions" and "Suggested prompts and questions" match the saved values.
- [ ] Existing chatbot with suggested prompts: each saved prompt shows as a card. The name is the card title, and the prompt text is below it.
- [ ] Existing chatbot with a language code not in the list (for example `en-GB`): the Language select shows that code instead of going blank.
- [ ] Loading shows the shell skeleton first, then the fields. No console errors.

## 2. Typing and dirty state

- [ ] Typing in any text field marks the shell "Unsaved changes" badge.
- [ ] Changing the bubble design, language, or either switch also marks the badge.
- [ ] Editing a field, then reverting it to the saved value, clears the badge.
- [ ] Reloading the page with unsaved edits shows "Unsaved changes restored" with a Discard button. Discard returns the saved values.

## 3. Required fields and length limits (errors show after the field loses focus)

- [ ] Fresh new-chatbot form: no error text is visible before any field is touched.
- [ ] Title left empty, then focus leaves: "Title is required."
- [ ] Title of only spaces: "Title is required."
- [ ] Title of 201 characters: "Title must be 200 characters or fewer." Title of exactly 200: no error.
- [ ] Bubble message empty: "Bubble message is required." 201 characters: "Bubble message must be 200 characters or fewer."
- [ ] Welcome message empty: "Welcome message is required." 2001 characters: "Welcome message must be 2000 characters or fewer."
- [ ] Instructions empty: "Instructions are required." 20001 characters: "Instructions must be 20000 characters or fewer."
- [ ] Each error clears as soon as the value becomes valid.
- [ ] Error text is red and sits under its field.

## 4. Promo banner settings (bubble design "Promo Banner")

- [ ] Choosing "Promo Banner" shows the "Promo banner settings" row with a Configure button. Choosing any other design hides it.
- [ ] Values entered in the promo dialog stay after switching the design away and back.
- [ ] Banner title of 256 characters: "Banner title must be 255 characters or fewer."
- [ ] Banner description of 1001 characters: "Banner description must be 1000 characters or fewer."
- [ ] Button label of 101 characters: "Button label must be 100 characters or fewer."
- [ ] Button link `example.com` (no scheme): "Button link must be a full http or https address."
- [ ] Button link `ftp://example.com`: same message. `https://example.com/offer`: no error. Empty link: no error.
- [ ] With an invalid promo field, "Save settings" keeps the dialog open and shows the error. With all valid, it closes.
- [ ] Closing the dialog with Escape or the X while a promo field is invalid keeps it open and shows the error.

## 5. Promo banner image upload

- [ ] Unsaved chatbot (`?step=configure`, no id): the file input is disabled. The note "Save the chatbot first to upload a banner image." shows.
- [ ] Saved chatbot: pick a PNG or JPG under 4 MB. "Uploading..." shows and the input is disabled. On success, the preview appears. The shell shows "Unsaved changes". Save, then check the PATCH body includes `configure.promoBannerImage` with the returned path.
- [ ] Pick a non-image file (for example a PDF): "Choose an image file." shows. No request is sent (check the network panel).
- [ ] Pick an image over 4 MB: "Image must be 4 MB or smaller." shows. No request is sent.
- [ ] Backend returns 501 for the upload: the note "Saved on backend when builder routes ship." shows. No preview appears. The stored promo image value does not change.
- [ ] Backend returns 413, 415 or 500: the server message shows inline under the file input.
- [ ] Picking the same file twice in a row still triggers an upload.
- [ ] A saved banner image loads from its stored path after a page reload.

## 6. Suggested prompts

- [ ] Turning the switch on with no prompts opens "Add suggested prompt" straight away.
- [ ] Cancel on that dialog leaves the switch on and shows "No prompts added yet. Add one to get started."
- [ ] Name only (no prompt text): saves. The card shows the name, and the body shows "No prompt provided".
- [ ] Prompt text only (no name): saves. The card title shows "Untitled prompt".
- [ ] Both blank: "Please provide at least a prompt name or the prompt itself." shows in the dialog. Nothing is added.
- [ ] Name of 101 characters: "Prompt name must be 100 characters or fewer." Prompt of 1001 characters: "Prompt must be 1000 characters or fewer."
- [ ] Edit an existing prompt: the dialog is pre-filled. Saving replaces that card and keeps its position. Leading and trailing spaces are removed.
- [ ] Remove a prompt: the card goes. Removing the last prompt turns the switch off.
- [ ] Turning the switch off clears the list. Turning it on again shows an empty list.
- [ ] Add 20 prompts: "Add prompt" is disabled. Removing one re-enables it.
- [ ] Add and edit buttons have accessible names (screen reader or the accessibility tree shows "Edit prompt 1", "Remove prompt 1", and so on).

## 7. Save and navigation (shell Save and Next)

Success:
- [ ] New chatbot: fill the four required fields. Click Next. The chatbot is created, then the PATCH is sent. The page moves to `/app/chatbot-builder/wizard/<newId>?step=customize`. The toast "Chatbot saved" shows.
- [ ] Existing chatbot: change the title, click Save. The toast shows, the badge clears, and a reload keeps the new title.
- [ ] Existing chatbot: change bubble design, promo fields, and suggested prompts. Save. Reload. Every value matches.

Failure:
- [ ] Empty required field, then Save: the shell blocks the request and shows "Title is required." (or the matching message). Check the network panel. No POST or PATCH is sent.
- [ ] Server returns 400 with `issues`: the shell's error alert lists them as "path: message". The user stays on configure. The edits stay (badge still shows "Unsaved changes").
- [ ] Server returns 501 on PATCH (builder routes not shipped): the shell shows the error text. The fields stay editable, and nothing is lost.
- [ ] Network failure on Next: error alert shows, navigation does not happen.
- [ ] New chatbot where the create succeeds but the PATCH fails: the page moves to the new chatbot id on configure, with the error shown. Retrying Save does not create a second chatbot.

## 8. Disabled state while saving

- [ ] While a save runs, every input, select, switch, and icon button on this step is disabled.
- [ ] The Configure button for the promo banner and the Add prompt button are also disabled.

## 9. Layout and keyboard

- [ ] Clicking a label moves focus to its control (Title, Bubble message, Welcome message, Instructions, Language).
- [ ] Tab order runs top to bottom through the form, and the dialogs trap focus while open.
- [ ] iPad portrait width (about 820 px) and phone width (about 380 px): fields stack, and the promo and prompt dialogs scroll with their buttons still visible.
- [ ] No console errors or React key warnings when adding, editing, and removing prompts.
