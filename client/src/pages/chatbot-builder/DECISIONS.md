# Chatbot builder wizard: decisions

Scope of this pass: the shared contract, the shell, placeholder steps, and the backend endpoint map. The five steps are not built. The existing page (`ChatbotBuilder.tsx`) and the backend files are unchanged.

Field-by-field mapping is in `server/modules/chatbot/builder-routes/endpoint-map.md`.

## Decisions for the owner to review

1. **Builder routes live under `/api/chatbot/builder`, not in `chatbot-routes.ts`.** The existing routes are strict, and the wizard needs about 40 more fields. A separate router keeps the current routes as they are. The chatbot tables are still DRAFT (`migrations/DRAFT_chatbot.sql`), so the new columns need the same promotion.
2. **Route is `/app/chatbot-builder/wizard/:id?`, with the step in `?step=<id>`.** The existing `/app/chatbot-builder` route is untouched and matches exactly, so no route clashes. The optional id lets one component handle "create" and "edit". The step in the query keeps the path short and works with browser back. The path is in `wouter` v3 syntax (`regexparam` optional segment). Check it on first run.
3. **Creation uses the existing `POST /api/chatbot/chatbots`** with the six classic fields only, because the strict body rejects anything else. The rest goes in with one `PATCH /api/chatbot/builder/:id`. If that second call fails, the new id is kept and the user stays on the chatbot with a message. This avoids a second copy on retry.
4. **Save rules.** Moving forward (Next or a step button) saves changed groups first. If the save fails, the user stays on the step. Back does not save. Only `configure`, `customize` and `embed` are sent, and only when they changed.
5. **Required on save: title, bubble message, welcome message, instructions.** This matches core's update request. Desk's column for welcome message and instructions is nullable, so the backend keeps accepting null from older rows.
6. **Drafts are in localStorage, one key per chatbot** (`chatbot-wizard-draft:<id>`, or `:new` before the first save). They are restored with a notice and a Discard button, and cleared when the server copy matches them. Nothing is sent to the server until a save.
7. **Uploads need a saved chatbot.** On an unsaved configure step, the promo banner picker is disabled ("Save the chatbot first"). Upload calls are made with `fetch` and `FormData` in `api.ts`, because `apiRequest` only sends JSON.
8. **Uploads do not refresh an expired token.** `ensureValidToken` is private in `queryClient.ts`, so the upload helper cannot call it. If a session expires mid-upload, the user gets an error and retries after signing in. Export `ensureValidToken` if this matters.
9. **Channel step is registered but hidden** (`enabled: false`). Core shows it only when a channel add-on is installed, and Desk has none.
10. **Train step is shown but external.** Training needs an ingestion and embeddings provider. The step agent should show a clear "not available yet" state, not call endpoints that do not exist. There are no train functions in `api.ts`.
    - **Fix pass 2026-11-08 (H1):** the train entry in `steps.ts` now has `enabled: false`, so the step is hidden until the `/sources` backend exists. The step file is kept.
11. **Language list** reuses `client/src/lib/languages.ts` (`SUPPORTED_LANGUAGES`), plus "auto". Core filters the list by a site setting (`settings_two->languages`). Desk has no equivalent, so all languages are shown.
12. **Avatars.** Core has a `ChatbotAvatar` table with presets. Desk gets a new list endpoint (`GET /builder/avatars`) with presets plus company uploads. Upload limit is 4 MB, images only, the same as core's `avatar` rule.
13. **`trigger_background` becomes a boolean** (`transparentTrigger`). Core stores "transparent" or "". The backend maps it.
14. **Iframe width and height are client-only.** Core does not save them. They stay in the embed step's local state, and the wizard does not store them.
15. **`ai_model` is not mapped.** Its select is commented out in core. The backend supplies the default.
16. **Enums are duplicated as const arrays in `types.ts`** (bubble designs, header types, positions, upload kinds). Source: `System/Enums` in core. If the core enums change, update these.
17. **Core bugs not carried over.** The "Help Center" checkbox has `name="is_contact"` but writes `is_articles`. The trusted-domains textarea has `name="instructions"`. The wire names follow the Alpine bindings, so `isArticles` and `trustedDomains`.
18. **Wizard defaults** (`EMPTY_WIZARD_STATE`) are my choice. They are not checked against core's database defaults. Values from the server replace them.
19. **Limits** (`BUILDER_LIMITS`): bubble message 200, suggested prompts 20, prompt text 1000, trusted domains 50. Core has no limit for some of these. These numbers are my choice; the backend must match them.
20. **Image paths are checked for company ownership** on the backend. A path from another company is rejected.
21. **`generativeUiEnabled` stays on the existing page.** It is a Desk field with no core UI, so it is not in the wizard.
22. **The Desk `widget` module is a different product** (`website_widgets`, voice widget). The embed step does not use it.
23. **Shell is a single file.** A `state.ts` split was not needed for this size.

## App.tsx line for the owner to add

Not edited here, per the constraints. Add the import near the existing `ChatbotBuilder` import (line 84), and the route next to line 354:

```tsx
import ChatbotWizard from "@/pages/chatbot-builder/wizard-shell";
// ...
<Route path="/app/chatbot-builder/wizard/:id?" component={ChatbotWizard} />
```

Each step file must keep its default export. The registry uses `lazy(() => import(...))`.

**Fix pass 2026-11-08 (M6):** the route now renders `ChatbotWizard` only when `VITE_ENABLE_CHATBOT_BUILDER_ROUTES` is `"true"`. Otherwise it renders the existing `ChatbotBuilder`. The client reads a Vite build-time variable (the pattern `embed.tsx` already uses), so set it together with the server flag `ENABLE_CHATBOT_BUILDER_ROUTES`.

## Components

Used from `client/src/components/ui`: `button`, `badge`, `card`, `alert`, `skeleton`, `input`, `label`, `textarea`, `switch`, `select`, `radio-group`, `slider`, `checkbox`, `tabs`, `progress`, `separator`.

Missing, so step agents must build or inline them (not invented here):

- **Color picker.** Use `input type="color"` inside `Input`.
- **File drop zone.** Use `input type="file"` with a label.
- **Gradient editor.** Core uses a custom Alpine component. Needs custom code.
- **Avatar picker.** Build from `card` and `button`.
- **Range slider for avatar size.** `slider` exists, check its props.

## Could not map or could not do

- **Type-check was not run.** `node_modules` is absent, and CLAUDE.md says not to run a full `tsc` on this machine. The files were checked by reading only. Run a narrow check before merging.
- **Runtime checks were not run.** Route matching, the `?step=` handling, and the draft restore need a browser pass.
- **Train actions** (text, Q and A, URL crawl, PDF, embeddings) have no Desk equivalent. Left out of `api.ts` on purpose.
- **Channel actions** (channel list, delete, Instagram OAuth) have no Desk equivalent. Left out.
- **Add-on fields** (17 fields for agent, review, voice, booking, shop) are in core's request rules only. Their partials live in other extensions. Left out.
- **Public embed runtime** (`external-chatbot.js`) does not exist in Desk. The embed snippet shows the `uuid`, but the widget will not load until the runtime is added.
- **Storage methods and migrations** are described in `endpoint-map.md`, not written.

## Checklist entry

Per CLAUDE.md, behaviour-changing decisions are logged in `/home/claude/supercharged-fixes-checklist.md`. Entries for decisions 1, 2, 3 and 6 were added there.

## Channel step (steps/channel.tsx)

Owner: channel step builder. Scope: the channel UI, hidden behind a flag. Nothing is connected to a provider.

31. **The step is hidden by two switches that must change together.** `CHANNEL_STEP_ENABLED` in `channel.tsx` is `false`, and `enabled: false` on the channel entry in `steps.ts` hides the step in the wizard bar. To show it, the owner changes both:
    - `client/src/pages/chatbot-builder/steps/channel.tsx`: `export const CHANNEL_STEP_ENABLED = false;` to `export const CHANNEL_STEP_ENABLED = true;`
    - `client/src/pages/chatbot-builder/steps.ts`, inside the `id: "channel"` entry: `enabled: false,` to `enabled: true,`

    If only `steps.ts` changes, the step shows in the bar with an empty body. If only the flag changes, the step stays hidden. Do not flip one without the other.
32. **Channel connect and test are pending, with no provider call.** `requestChannelAction` in `channel.tsx` is a stub. It makes no network request and always returns "pending". Each action shows a pending label and a notice. Replace the stub when the channel routes exist. The routes are not in `endpoint-map.md` and must be added there first (list, connect, test, delete). Those routes must run on the server, never in the browser.
33. **Credentials stay out of WizardState.** The shell writes WizardState to a localStorage draft, so a token stored in `channel` would sit on disk. Typed values live in component state only. Only non-empty typed values are sent, and a saved secret is never returned to the browser. The UI shows it as a masked, read-only field with a Replace button. Owner to confirm: the channel service must return `secretSaved` flags with no values.
34. **Fields follow the core add-on cards.** Telegram: bot name, bot token. WhatsApp (Twilio): environment, account SID, auth token, production and sandbox numbers. Messenger: app ID, app secret, page name, webhook verify token. Instagram: sign-in only, because core fills its credentials from OAuth. Its app ID and app secret come from server settings, not from the user, so they are not shown. Owner to confirm the SID is treated as a secret (masked). It is an account identifier in Twilio, not a password.
35. **Website is a fixed row, not a channel.** The chat widget has no channel record in core. The row points to Test and embed.
36. **Enable switches stay disabled.** Each channel's enable switch needs a connected channel, and none can connect yet. The switch state is local and is not saved.
37. **Channel state is not in the save path.** `ChannelState` stays `{}`, and the shell does not send a channel group. Nothing changes in `api.ts` or `types.ts`.

## Embed step (step 4): decisions for review

Owner: embed step agent. Files: `steps/embed.tsx`, `steps/embed.test.md`. Browser checks are in `embed.test.md`.

24. **The snippet uses `embed.uuid`, not the wizard's chatbot id.** The contract calls `uuid` the public id for the snippet, and the runtime calls `/api/v2/chatbot/<uuid>`. The internal id is never embedded.
25. **Script URL is configuration.** `VITE_CHATBOT_WIDGET_BASE_URL` plus `/vendor/chatbot/js/external-chatbot.js`. With the variable unset, the page origin is used. The runtime takes its host from the script `src`, so this base must be the Desk origin that serves `/chatbot/<uuid>/frame` and `/api/v2/chatbot/<uuid>`. The path is my choice, copied from core's blade.
26. **Install check is EXTERNAL and local to the step.** The brief asked for the marking in `api.ts`. The file rules allowed only the step file, this section and the test file, so `api.ts` is unchanged. The owner should move it to `api.ts` if preferred. The button is disabled and shows "Pending", and it makes no call.
27. **Active warning reads the saved flag** from `GET /api/chatbot/chatbots` (EXISTS), because the embed step only receives its own group. It does not follow unsaved changes.
28. **Iframe defaults 400 by 600 px**, range 100 to 1000 in steps of 50 (core's slider range). The defaults are my choice; core's defaults were not checked. Not saved, as in core.
29. **`data-language` is left out** of the snippet. Core hard-codes `en`, but the runtime prefers the page's `<html lang>`, so the attribute only forces a fallback.
30. **Trusted domains are normalised in the browser** (protocol, path and trailing dot removed, lowercased). Entries that fail the hostname check are not saved. Over 50 entries, the last valid list is kept. The backend should apply the same rules.
31. **Port is rejected, which conflicts with the contract.** `types.ts` and `endpoint-map.md` say "hostname with an optional port". The runtime compares `window.location.hostname`, which never includes a port, so a port would never match. The owner should confirm and update the contract.
32. **Copy falls back** to a hidden textarea with `execCommand` when the Clipboard API is missing or the page is not a secure context. If both fail, the code box is selectable.

Open for the owner: the type-only `import.meta.env` access in `embed.tsx` needs a Vite client type reference (for example `client/src/vite-env.d.ts` with `/// <reference types="vite/client" />`). The tsconfig lists only `node` in `types`, so the reference is missing today. No full `tsc` run was done (no `node_modules`, no `CLAUDE.md`). Only an esbuild parse ran.

## Train step (steps/train.tsx): decisions for review

Owner: train step builder. Files: `steps/train.tsx`, `steps/train.test.md`. Browser checks are in `train.test.md`. Numbering starts at T1 to avoid clashes with the sections above.

- **T1. The sources routes are not in `endpoint-map.md`.** The brief said Q&A and text save "through endpoint-map.md", but that file has no source routes. The step uses these proposed routes, all under `/api/chatbot/builder/:id/sources`:
    - `GET` list, `POST` text or Q&A record (wired)
    - `POST /website` (crawl), `POST /file` (multipart), `POST /train`, `DELETE /:sourceId` (EXTERNAL)

    The owner must add these rows to `endpoint-map.md` before the backend is built. Until then, the list and save calls return 404 and show the error state.
- **T2. No train functions in `api.ts`.** The brief asked for EXTERNAL functions there, but this step may not edit `api.ts`. The calls are local to `train.tsx`, and each one is marked EXTERNAL. Move them to `api.ts` if preferred.
- **T3. Text and Q&A are saved before embedding.** Core's `trainText` and `trainQa` store the record with no embedding, so these save without the external provider. The records show "Not trained" until training runs.
- **T4. Q&A sends `title` as the question and `content` as the answer.** Core joins them as `question : answer` on the server. The client sends them separately, so the server decides how to store them. The owner should confirm.
- **T5. The "not connected" state shows on any failure from an external action,** not only on 501. Any error from crawl, upload, train or delete shows "Training backend not connected in Desk yet", with the error text as detail. The state clears when one external action succeeds.
- **T6. File limits come from core's UI copy, not the request class.** `FileRequest` sets only `required|file`. The step uses 25 MB ("Max: 25Mb" in core) and the extensions the controller routes to parsers: pdf, xlsx, xls, csv, txt, json. Core's `accept="file/*"` is not a real MIME type, so it was replaced with an extension list. The server's PHP upload limit may still be lower than 25 MB.
- **T7. URL rules are stricter than core.** Core uses Laravel's `url` rule, which accepts other schemes. The step accepts only http and https, requires a dot in the host (so `localhost` fails), and caps the length at 2048 characters. The 2048 cap is my choice.
- **T8. Source type values follow core's enum.** Wire `type` is `website`, `file`, `text` or `qa`. The PDF tab uses `file`. The owner should confirm the server returns the same values.
- **T9. Source status is a boolean `trained`.** Core uses the status string "Trained". The step shows the badge from the boolean.
- **T10. Q&A labels changed.** Core labels the Q&A fields "Title" and "Text", but they hold a question and an answer. The step labels them "Question" and "Answer".
- **T11. Train and Delete are EXTERNAL and need no extra gate.** Core's Delete uses `confirm()`. The step does the same with "Delete this source?". No provider call is made from the browser.
- **T12. Website crawl does not save wizard state.** The URL and crawl mode are local to the step, and `TrainState` stays `{}`, as the contract says. The shell's save path is unchanged.

## Configure step (steps/configure.tsx): decisions for review

Owner: configure step agent. Files: `steps/configure.tsx`, `steps/configure.test.md`. Browser checks are in `configure.test.md`. Numbering starts at C1.

- **C1. Ported: 14 fields, including the promo image upload.** Existing (EXISTS): title, language, welcome message, instructions. New (NEW, rendered): bubble message, bubble design, promo banner image (upload), promo title, promo description, promo button label, promo button link, do not go beyond instructions, suggested prompts enabled, suggested prompts list. `active` is not shown, because core toggles it in the chatbot list, not in the wizard. Its value still flows through the shell.
- **C2. Not ported, on purpose.** The `ai_model` select (commented out in core). Add-on partials for human agent, review, voice, booking and ecommerce (EXTERNAL, not in this extension). The live preview calls into `externalChatbot` (no widget runtime in Desk). The language list is not filtered by a site setting: all supported languages show, as decision 11 says.
- **C3. Only the promo upload calls the API directly.** It calls `uploadBuilderImage(chatbotId, "promo_banner", file)`. Its 501 response shows "Saved on backend when builder routes ship." and leaves the stored value unchanged. Every other field goes through `onChange`, and the shell saves it. A 501 on save reaches the user as the shell's error alert, not as this note. The owner should decide if the shell needs to show the note for saves too.
- **C4. Upload is disabled until the chatbot is saved.** It is also blocked above 4 MB and for non-image files, with the same limit as `BUILDER_LIMITS.uploadBytes`. The preview uses the upload's URL for this session. After a reload, it uses the stored path as the image source, which assumes `/uploads/...` is served from the Desk origin.
- **C5. Extra checks beyond core's (the server is still the gate).** Core's Blade has no client validation. These follow `endpoint-map.md` section 4: the button link must be http or https (core only checks for a string), the link is capped at 2048 characters, and the banner, prompt and prompt-name limits from `BUILDER_LIMITS` apply. The shell still checks only its four required fields and their lengths. These extra checks show inline and do not block the shell's save. The owner should decide whether to block save on them.
- **C6. Errors show after a field loses focus.** Core showed server errors only after a save. A blank new form therefore has no red text until the user visits a field.
- **C7. "Save settings" in the promo dialog does not close it while a banner field is invalid.** Core always closed it. Closing with Escape or the X has the same rule.
- **C8. Core behaviour kept on suggested prompts.** Turning the switch off clears the list at once, with no confirm. Turning it on with no prompts opens the add dialog. Removing the last prompt turns the switch off. Saving a prompt sets the switch to "has prompts". Core's rule that at least a name or a prompt text must be given is kept, with the same message.
- **C9. A saved language that is not in the list stays visible.** Otherwise the select shows blank. The value is shown as its raw code.
- **C10. No remove action for the banner image.** Core has none. A new upload replaces the image. The owner may want a remove button.
- **C11. Error text uses the shadcn `text-destructive` class,** not core's `text-red-500`. Dialogs use the shared `Dialog` component, and the switches use `Switch`. No new shared component was needed.
- **C12. Checks not run.** No `node_modules`, so no `tsc`. CLAUDE.md forbids a full `tsc` on this machine. The file was checked with the TypeScript parser alone (`ts.createSourceFile`, syntax diagnostics only). Types are unchecked. Run a narrow type check before merging.
- **C13. Checklist entry not written.** Repo CLAUDE.md asks behaviour-changing decisions to be logged in `/home/claude/supercharged-fixes-checklist.md`. This agent was told to edit only its DECISIONS section and test file, so the log entries (C3, C4, C5, C7, C8) are for the main session to add.

## Customize step (steps/customize.tsx): decisions for review

Owner: customize step agent. Files: `steps/customize.tsx`, `steps/customize.test.md`. Browser checks are in `customize.test.md`. Numbering starts at CU1.

- **CU1. Promo banner and suggested prompts are not in this step.** The brief listed them under Customize, but `types.ts` and the core Blade put them in Configure (see C1). The footer link is in this step, as `footerLink`.
- **CU2. No contrast checks were carried over, because none exist.** The customize Blade and its Alpine handlers (`edit-window.blade.php`) have no contrast logic. The only check added is `#RRGGBB` validation. A WCAG contrast warning would be new behaviour, so it was not added. The owner should decide.
- **CU3. Uploads call the declared `api.ts` functions, which are backend pending.** Logo, welcome background and header image call `uploadBuilderImage`. The avatar upload calls `uploadBuilderAvatar`. The step shows picked, uploading, and failed states. The saved value changes only after the server returns a path. Image uploads need a saved chatbot, as in C4. The avatar upload does not.
- **CU4. The avatar list is backend pending too.** `listBuilderAvatars` failing shows a red note, and the upload still works.
- **CU5. Colour values are `#RRGGBB` only,** stored in upper case, as the contract says. Core accepts other forms through its picker. The header colour may be empty, which saves `null`. The accent colour may not.
- **CU6. Links are checked in the browser.** Each must be an http or https URL of 2048 characters or fewer, as in `endpoint-map.md` section 4. Core checks nothing here. An invalid value is not saved, and the text stays with its error.
- **CU7. The gradient uses core's output format** (`linear-gradient(<deg>, <colour> <n>%, ...)` and `radial-gradient(circle, ...)`), read from `edit-window.blade.php`. Desk limits stops to 2 through 8, a choice of mine. Core has no limit. Stop colours must be hex, but core accepts any CSS colour. A saved gradient in another format opens the default editor and shows the saved text until the user edits it.
- **CU8. Gradient actions are ported:** click the bar to add a stop, drag a stop, drag the angle dial, and remove stops above two. Arrow keys nudge a stop, added for keyboard use. Core's "add stop" rule is simplified: it skips the nudge for duplicate positions.
- **CU9. The preview is a schematic and uses placeholder text.** `StepProps` gives this step only the customize group, so the title and welcome message (in Configure) are not available. Showing them needs a shell change, which this agent may not make. The preview is also not the core widget, and it does not load `external-chatbot.js`.
- **CU10. The step has its own "Save this step" button,** calling `saveNow`. It shows "Saved." or "Not saved." The shell's Save and Next still save the same groups.
- **CU11. Trigger size is a slider from 20 to 100 px,** stored as `"NNpx"`. The core slider uses the same range.
- **CU12. Checks run.** There is no `client/node_modules` and no `CLAUDE.md`, so no full repo type check was run. An esbuild parse of the step passed. A scoped `tsc` ran in a scratch directory outside the repo, with the step, `api.ts`, `types.ts` and the UI components it uses. It reported zero errors. The scratch install used React 18.3.1, `@tanstack/react-query` 5 and `lucide-react` 0.453.0, so the repo's own versions were not checked.
- **CU13. Core's Help Center bug is not copied.** The Help Center toggle writes `isArticles`, not the `is_contact` name in the core input (see decision 17).
