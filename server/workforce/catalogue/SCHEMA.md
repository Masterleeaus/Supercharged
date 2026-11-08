# Workforce role catalogue: schema

Every workforce role is a data file. Each file named-exports a single object named
`role` (no default export) that conforms to `RoleDefinitionSchema`
(`role.schema.ts`). Files live in `roles/` and are named `<role-id>.ts`.
Files starting with `_` are examples and are never loaded as roles.

Validate with `validateRoleDefinition(raw)` for one role, or
`validateCatalogue(roles)` / `loadCatalogue(modules)` for the whole set.

## Rules for role-writing agents

1. Create exactly one file per role at `roles/<id>.ts`. The file name equals `id`.
2. Export `role` typed as `RoleInput` (imported type from `../role.schema.ts`). Do not
   add other runtime exports.
3. Copy the worked example below. Do not add fields. The schema is `.strict()`, so
   unknown keys fail validation.
4. Never put company data in a role: no company names, addresses, phone numbers,
   emails, IDs, pricing, staff names, or API keys. Use `{{company_name}}` and
   `{{vertical}}` only.
5. Set `sourceRef` to a Desk preset name (exact string), a Field native id, or `"new"`.
6. Every tool in `tools` needs a `toolRisk` entry, and every `toolRisk` key must be in `tools`.
7. If any tool is `critical`, leave `autonomy` at `auto` or set it stricter.
8. Run `node --test tests/workforce/catalogue.test.mjs` and `validateCatalogue` over
   the whole `roles/` set before handing off.

## Fields

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | Kebab-case, `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, max 64. Unique across the catalogue. |
| `name` | string | yes | Trimmed, 3 to 80 characters. Human display name. |
| `description` | string | yes | Trimmed, 20 to 400 characters. One or two sentences on what the role does. |
| `verticals` | array of Vertical | yes | 1 to 12 unique items. See Vertical enum. |
| `category` | Category | yes | Exactly one value from the Category enum. |
| `systemPrompt` | string | yes | 80 to 8000 characters. Must contain `{{company_name}}` and `{{vertical}}`. No other `{{...}}` placeholders. No literal phone number, email or API key. |
| `channels` | array of Channel | yes | 1 to 6 unique items from `voice`, `chat`, `sms`, `email`, `whatsapp`, `web`. |
| `autonomy` | Autonomy | no, default `assist` | One of `assist`, `suggest`, `auto`, `predictive`. Least to most autonomous in that order. `assist` responds only when asked; `suggest` watches and notifies with a suggestion; `auto` runs set daily tasks and needs owner approval for money movement, outbound customer messages and record deletion; `predictive` prepares ahead using data. |
| `tools` | array of tool id | yes | Up to 60 unique ids. Pattern `^[a-z][a-z0-9]*([._-][a-z0-9]+)*$`, e.g. `booking_requests.create`. May be empty. |
| `toolRisk` | map tool id to risk | yes | Must have exactly one key per entry in `tools`. Risk is `low`, `medium`, `high` or `critical`. |
| `guardrails` | array of string | yes | 1 to 30 items, each 10 to 300 characters. Topics or actions the role refuses or must hand off. |
| `handoffTo` | array of role id | no, default `[]` | Up to 20 unique kebab ids. Each must be the `id` of another role in the same catalogue. Cannot contain the role's own id. |
| `kpis` | array of string | yes | 1 to 20 items, each 3 to 160 characters. |
| `sourceRef` | string | yes | Exactly one of: a Desk preset name (below), a Field native id (`reception`, `sales`, `booking`, `scheduling`, `jobs`, `customer_care`), or `"new"`. |
| `companyScope` | `"required"` | yes | Must be the literal string `"required"`. |

### Vertical enum

`cleaning`, `pool`, `garden`, `pest`, `plumbing`, `electrical`, `hvac`, `handyman`,
`locksmith`, `painting`, `general_field_service`, `cross_vertical`

### Category enum

`reception`, `sales`, `booking`, `scheduling`, `jobs`, `customer_care`, `billing`,
`collections`, `quotes`, `marketing`, `compliance`, `hr`, `operations`, `reporting`

### Desk preset names (valid `sourceRef` values)

`Virtual Receptionist Agent`, `Appointment Setter Agent`, `Lead Qualification Agent`,
`Survey & Feedback Agent`, `Customer Service Agent`, `Outbound Sales Agent`,
`Debt Collection Agent`, `Event Registration Agent`

These come from `server/seed-agent-templates.ts`. The test suite fails if that file's
agent presets drift from this list.

### Cross-role rules (`validateCatalogue`)

- Role ids are unique across the catalogue. Duplicates are checked on raw ids, so an
  invalid role cannot hide a duplicate.
- Every `handoffTo` id resolves to a role in the same catalogue.

### Single-role rules (`validateRoleDefinition`)

- Every tool has a risk level, and no risk entry names a tool that is not listed.
- A `critical` tool requires `autonomy` of `auto` or stricter.
- No self-handoff.
- `systemPrompt` placeholders are limited to `company_name` and `vertical`, and both must appear.
- `systemPrompt` has no literal email, phone number or API key. Phone numbers are
  matched when they start with `+`, `0` or `(0x)` and contain 8 to 15 digits. Dates
  and times do not match. Matched text is never echoed in errors.

## Errors

Validators return `{ ok: false, errors: [{ path, message }] }`. Paths are dotted, for
example `autonomy`, `toolRisk.clients.list`, `roles[3].handoffTo.0`, or
`modules[2].id` for `loadCatalogue`.

## Worked example

`roles/_example.ts` is the full, tested version. Summary of its fields:

```ts
import type { RoleInput } from "../role.schema.ts";

export const role: RoleInput = {
  id: "example-reception-triage",
  name: "Example Reception Triage",
  description:
    "Answers inbound enquiries for {{company_name}}, captures the service request and routes it to booking or customer care.",
  verticals: ["general_field_service"],
  category: "reception",
  systemPrompt: [
    "You are the front-desk assistant for {{company_name}}, a {{vertical}} business.",
    "Greet the caller, identify what service they need and capture the request.",
    "Look up an existing client before creating a new one, so records are not duplicated.",
    "Never quote prices, promise dates or confirm bookings. Those belong to other roles.",
    "If the caller describes an emergency or a safety risk, stop and hand off to a person right away.",
  ].join("\n"),
  channels: ["voice", "sms"],
  autonomy: "auto",
  tools: ["clients.list", "booking_requests.list", "booking_requests.create"],
  toolRisk: {
    "clients.list": "low",
    "booking_requests.list": "low",
    "booking_requests.create": "medium",
  },
  guardrails: [
    "Do not quote prices, discounts or refunds.",
    "Do not confirm a booking time; capture the request only.",
    "Do not give safety or diagnostic advice; escalate emergencies to a person.",
  ],
  handoffTo: [],
  kpis: [
    "Share of enquiries captured as a complete booking request",
    "Average time from call start to request captured",
  ],
  sourceRef: "Virtual Receptionist Agent",
  companyScope: "required",
};
```

## Running the checks

```sh
node --test tests/workforce/catalogue.test.mjs
```

zod is declared in `package.json` but may be missing from `node_modules`. When the plain
import fails, the test registers `tests/workforce/zod-fallback.hooks.mjs`, which resolves
`zod` to `/opt/npm-tools/node_modules/zod/index.js`. Set `ZOD_FALLBACK_ENTRY` to use a
different entry file.
