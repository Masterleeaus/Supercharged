# Chatbot builder: endpoint map

Contract for the backend owner. The frontend contract is `client/src/pages/chatbot-builder/types.ts` and `api.ts`. This file is the source for the request and response shapes there.

Nothing here is implemented yet. The routes go in a new file, `server/modules/chatbot/builder-routes/builder-router.ts`, not in `chatbot-routes.ts`. The existing routes stay as they are.

## 1. Endpoints

Base path: `/api/chatbot`. Tenancy and roles follow `chatbot-routes.ts`: the company id comes only from `res.locals.companyId` (the `scoped()` wrapper), never from the body. Reads use `readRoles` (admin, manager, agent). Writes use `configRoles` (admin, manager).

| # | Method | Path | Roles | Status |
|---|---|---|---|---|
| 1 | GET | `/api/chatbot/chatbots` | read | EXISTS (used by the wizard, unchanged) |
| 2 | POST | `/api/chatbot/chatbots` | config | EXISTS (used on the first save only, six classic fields) |
| 3 | GET | `/api/chatbot/builder/avatars` | read | NEW |
| 4 | POST | `/api/chatbot/builder/avatars` | config | NEW |
| 5 | GET | `/api/chatbot/builder/:id` | read | NEW |
| 6 | PATCH | `/api/chatbot/builder/:id` | config | NEW |
| 7 | POST | `/api/chatbot/builder/:id/uploads` | config | NEW |

Route order matters. Register rows 3 and 4 before any `/builder/:id` route, or `avatars` is read as an id. The id pattern is `ID_PATTERN` from `chatbot-routes.ts`.

### 3. GET /api/chatbot/builder/avatars

- Request: none.
- Response 200: `BuilderAvatar[]` where `BuilderAvatar = { id: string, path: string, url: string }`. Presets (company id null) first, then this company's uploads.
- Storage: `listChatbotAvatars(companyId)` (new, see section 3).

### 4. POST /api/chatbot/builder/avatars

- Request: multipart. Field `avatar`: image, max 4096 KB (core rule: `image`, `max:4096`).
- Response 201: `BuilderAvatar`.
- Errors: 400 missing or invalid file, 413 too large, 415 not an image.
- Storage: file store `saveBuilderFile(companyId, "avatars", file)` and `insertChatbotAvatar(companyId, path, now)` (new).
- Path returned: `/uploads/avatars/<companyId>/<random>.<ext>`.

### 5. GET /api/chatbot/builder/:id

- Request: path `:id`.
- Response 200: `BuilderSnapshot`:
  ```json
  {
    "id": "string",
    "updatedAt": "ISO-8601",
    "state": {
      "configure": { "title": "", "language": "en", "welcomeMessage": "", "instructions": "", "active": true, "bubbleMessage": "", "bubbleDesign": "blank", "promoBannerImage": null, "promoBannerTitle": "", "promoBannerDescription": "", "promoBannerButtonLabel": "", "promoBannerButtonLink": "", "doNotGoBeyondInstructions": false, "suggestedPromptsEnabled": false, "suggestedPrompts": [] },
      "customize": { "...all 28 keys in section 2, see types.ts CustomizeState..." },
      "train": {},
      "embed": { "trustedDomains": [], "uuid": "string" },
      "channel": {}
    }
  }
  ```
- Errors: 400 invalid id, 404 chatbot not found (not found in this company looks the same).
- Storage: `findChatbot(companyId, id)` (existing) for the six classic columns, plus `findBuilderSettings(companyId, id)` (new). Merge the two into `state`.

### 6. PATCH /api/chatbot/builder/:id

- Request: JSON, a `BuilderPatch`. Send only changed groups and keys.
  ```json
  {
    "configure": { "title": "string", "bubbleDesign": "promo_banner" },
    "customize": { "color": "#3B82F6", "position": "left" },
    "embed": { "trustedDomains": ["example.com"] }
  }
  ```
- Rules: every object is `.strict()`. Unknown keys return 400. `embed.uuid` is read-only, so sending it returns 400. Every key is optional.
- Response 200: `BuilderSnapshot` (same as section 5, after the write).
- Errors: 400 `{ error: "Invalid input", issues }` (same shape as the existing routes), 404.
- Storage:
  - The five classic keys (`title`, `language`, `welcomeMessage`, `instructions`, `active`) go through `updateChatbot(companyId, id, patch, now)` (existing).
  - Everything else goes through `updateBuilderSettings(companyId, id, patch, now)` (new). It merges into the JSON column, not replaces it.
  - Write the two in one transaction.

### 7. POST /api/chatbot/builder/:id/uploads

- Request: multipart. Fields:
  - `kind`: one of `logo`, `welcome_bg`, `header_bg`, `promo_banner`. Each one sets one field (see section 2).
  - `file`: image, max 4096 KB.
- Response 201: `{ "path": "/uploads/chatbot/<companyId>/<random>.<ext>", "url": "https://..." }`.
- Errors: 400 bad kind, 404 chatbot not found, 413, 415.
- Storage: `findChatbot` (existing) for the 404, then `saveBuilderFile(companyId, "chatbot", file)`. No DB row. The path is returned, and the client stores it with the next PATCH.

## 2. Field classification (PHP name to wire name)

Source: the step Blade files and the request rules in `extensions/chatbot/System/Http/Requests`.

Status key: EXISTS = already in the Desk chatbot table. NEW = needs one of the routes above. EXTERNAL = a training, channel or add-on service that is out of scope this round.

**Step 1, Configure (14 fields: 4 EXISTS, 10 NEW)**

| Core field | Wire name | Status |
|---|---|---|
| title | title | EXISTS |
| language | language | EXISTS (core value "auto" or a locale code) |
| welcome_message | welcomeMessage | EXISTS (Desk column is nullable; the wizard requires it, as core does) |
| instructions | instructions | EXISTS (same as above) |
| bubble_message | bubbleMessage | NEW |
| bubble_design | bubbleDesign | NEW (enum: blank, plain, links, modern, suggestions, promo_banner) |
| promo_banner_image | promoBannerImage | NEW (upload kind `promo_banner`) |
| promo_banner_title | promoBannerTitle | NEW |
| promo_banner_description | promoBannerDescription | NEW |
| promo_banner_btn_label | promoBannerButtonLabel | NEW |
| promo_banner_btn_link | promoBannerButtonLink | NEW |
| do_not_go_beyond_instructions | doNotGoBeyondInstructions | NEW |
| suggested_prompts_enabled | suggestedPromptsEnabled | NEW |
| suggested_prompts[] (name, prompt) | suggestedPrompts | NEW |

**Step 2, Customize (28 fields, all NEW)**

| Core field | Wire name | Notes |
|---|---|---|
| logo | logo | upload kind `logo` |
| welcome_bg_image | welcomeBgImage | upload kind `welcome_bg` |
| avatar | avatar | path from the avatars list, or an uploaded avatar |
| color | color | hex |
| header_bg_type | headerBgType | enum: color, gradient, image |
| header_bg_color | headerBgColor | hex |
| header_bg_gradient | headerBgGradient | CSS gradient string |
| header_bg_image | headerBgImage | upload kind `header_bg` |
| show_logo | showLogo | boolean |
| show_date_and_time | showDateAndTime | boolean |
| is_emoji | isEmoji | boolean |
| is_links | isLinks | boolean |
| show_social_links_in_first_message | showSocialLinksInFirstMessage | boolean |
| is_email_collect | isEmailCollect | boolean |
| is_contact | isContact | boolean |
| is_articles | isArticles | boolean. Label is "Help Center". See the core bug note in section 4. |
| is_gdpr | isGdpr | boolean |
| trigger_background | transparentTrigger | core stores "transparent" or "". Backend maps true to "transparent", false to "". |
| trigger_avatar_size | triggerAvatarSize | "NNpx", range 20 to 100 |
| position | position | enum: left, right |
| footer_link | footerLink | URL or null |
| whatsapp_link | whatsappLink | URL or null |
| telegram_link | telegramLink | URL or null |
| facebook_link | facebookLink | URL or null |
| instagram_link | instagramLink | URL or null |
| watch_product_tour_link | watchProductTourLink | URL or null |
| privacy_policy_link | privacyPolicyLink | URL or null |
| terms_of_service_link | termsOfServiceLink | URL or null |

**Step 3, Train (7 fields and 3 actions, all EXTERNAL)**

- Fields: `title` and `content` (text source), `question` and `answer` (Q and A source), `url` and `single` (website crawl), `file` (PDF upload).
- Actions: list embeddings, delete embeddings, generate embeddings.
- Reason: needs a crawler, PDF parsing and an embeddings provider. Desk has none of these in the chatbot module.

**Step 4, Test and embed (1 NEW input, 1 NEW read-only, 2 client-only)**

| Core field | Wire name | Status |
|---|---|---|
| trusted_domains | trustedDomains | NEW (array of hostnames) |
| uuid | uuid | NEW, read-only. Public id in the embed snippet. Desk has no column for it. |
| iframe_width, iframe_height | (none) | Client-only. Core does not save them. The step keeps them in local state. |

The embed snippet also needs the public widget script (`external-chatbot.js`). That runtime is EXTERNAL and not in this round.

**Step 5, Channel (EXTERNAL, actions only)**

- Channel cards and list, channel delete, and Instagram OAuth (`chatbot-multi-channel` routes and the four channel add-ons).
- Core shows this step only when a channel add-on is installed. The registry hides it (`enabled: false`).

**Add-on fields (17, EXTERNAL, request rules only)**

These come from add-on partials that are not in this extension. They are not in the wizard this round.

- Human agent: `human_agent_conditions`
- Review: `is_review_enabled`, `review_prompt`, `review_responses`
- Voice call: `voice_call_enabled`, `voice_call_first_message`
- Booking: `is_booking_assistant`, `booking_assistant_conditions`, `booking_assistant_iframe`
- Shop: `is_shop`, `shop_source`, `shop_features`, `shopify_domain`, `shopify_access_token`, `woocommerce_domain`, `woocommerce_consumer_key`, `woocommerce_consumer_secret`

**In the core request rules but with no UI in these step files (not mapped, 7 fields)**

`ai_model` (its select is commented out in configure, but core's update request requires it, so the backend must supply a default), `interaction_type`, `color_mode`, `trigger_foreground`, `show_average_response_time`, `connect_message`, `is_attachment`.

**Desk only, not in the core UI**

`active` is toggled from the chatbot list in core. It is in the wizard group (`configure.active`). `generativeUiEnabled` is not in the wizard. It stays on the existing page.

**Totals (step UI)**: EXISTS 4 (+ `active`), NEW 40 (39 inputs and the read-only `uuid`), EXTERNAL 24 (7 train fields and 17 add-on fields), not mapped 7, client-only 2.

## 3. Storage and schema additions

These are for the owner. Nothing here is edited by the contract agent. `shared/schema.ts` and `chatbot-storage.ts` are unchanged.

Methods on `BuilderStorage` (`server/modules/chatbot/builder-routes/builder-storage.ts`, the names the backend implements; the integration pass aligned this section with them):

- `findBuilderState(companyId, id): Promise<BuilderStateRecord | null>`. Returns the five classic columns, the settings JSON and `publicUuid`. Replaces the older `findChatbot` plus `findBuilderSettings` pair.
- `updateBuilderState(companyId, id, { chatbot, settings }, now): Promise<BuilderStateRecord | null>`. Writes the classic columns and merges the settings JSON in one transaction. Replaces the older `updateChatbot` plus `updateBuilderSettings` pair.
- `listChatbotAvatars(companyId): Promise<BuilderAvatarRecord[]>`. Presets first, then this company's uploads.
- Not yet in the interface: `insertChatbotAvatar`, which the avatar upload needs once the file store exists.

Also a file store, separate from `ChatbotStorage`: `saveBuilderFile(companyId, area, file): Promise<{ path: string, url: string }>`. Writes under the public disk, the same as core (`uploads/...`).

Schema (new DRAFT migration, promoted with the chatbot tables):

- `chatbots.builder_settings` `jsonb not null default '{}'`. Holds section 2's NEW keys in wire names.
- `chatbots.public_uuid` `uuid not null default gen_random_uuid()`, unique. Returned as `embed.uuid`.
- `chatbot_avatars` (`id`, `company_id` nullable, `path`, `created_at`). Null company id marks a preset.

Note: `migrations/DRAFT_chatbot.sql` is still a draft, and `server/routes.ts` (around line 1742) says requests fail until it is applied. The builder columns must be added to that same promoted set.

## 4. Validation (server side)

Mirror these limits. They are in `BUILDER_LIMITS` in `types.ts`.

- `title`: 1 to 200 characters after trim (existing rule).
- `language`: 2 to 10 characters (existing rule).
- `bubbleMessage`: up to 200 characters.
- `welcomeMessage`: up to 2000 characters. `instructions`: up to 20000 characters.
- Promo banner: `promoBannerTitle` up to 255, `promoBannerDescription` up to 1000, `promoBannerButtonLabel` up to 100. `promoBannerButtonLink` is an http or https URL, or empty.
- `suggestedPrompts`: up to 20 items. `name` up to 100 characters, `prompt` up to 1000 characters.
- Enums: `bubbleDesign`, `headerBgType`, `position`, and the upload `kind`.
- Image paths (`logo`, `welcomeBgImage`, `headerBgImage`, `promoBannerImage`, `avatar`): empty, or a path that starts with `/uploads/chatbot/<companyId>/` or `/uploads/avatars/` (own company or preset only). The backend must reject another company's path.
- `color`, `headerBgColor`: `#RRGGBB`, or null.
- `headerBgGradient`: up to 500 characters, starts with `linear-gradient(` or `radial-gradient(`.
- `triggerAvatarSize`: `NNpx`, NN from 20 to 100.
- Link fields: http or https URL up to 2048 characters, or empty or null.
- `trustedDomains`: up to 50 entries. Strip the protocol and trailing slash. Each must be a hostname with an optional port.

Core bug notes (not carried over):

- The "Help Center" checkbox (`is_articles`) is rendered with `name="is_contact"`. The wire name follows the x-model, `isArticles`.
- The trusted-domains textarea is rendered with `name="instructions"`. The wire name is `trustedDomains`.
- `ChatbotUpdateRequest` requires `ai_model`, but the UI for it is commented out. Use the backend default.
