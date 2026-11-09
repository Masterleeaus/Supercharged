# Licence owner brief (issue #37)

Date: 2026-11-09
Branch: claude/licence-brief
Status: for the owner to decide. Issue #37 is still open.

This is not legal advice. It lists what the repository says. It does not decide what the law requires.

## Short summary

- The root `LICENSE` file is MIT. It names "Diploy - Bisht Technologies Private Limited" as copyright holder (2025).
- The root `package.json` also says MIT.
- The README says the product is sold under a CodeCanyon / Envato Regular or Extended Licence. Its "License Terms" say: "You cannot redistribute the source code."
- About 287 files carry a header that says "Distributed under the Envato / CodeCanyon License Agreement" and "You are NOT permitted to redistribute, resell, sublicense, or share this source code."
- So the repo says two different things. MIT lets anyone copy and redistribute. The CodeCanyon header and README say no redistribution.
- Some other folders carry their own licence, a proprietary notice, or no licence at all. They are listed below.

## Components and their stated terms

| Component | Where it lives | Terms as written in the repo |
| --- | --- | --- |
| Main product (AgentLabs / Diploy) | `LICENSE`, `package.json` | MIT, copyright Diploy - Bisht Technologies Private Limited, 2025 |
| Main product, CodeCanyon terms | `README.md` (Support & License), `INSTALLATION.md` | CodeCanyon Regular or Extended Licence. No redistribution of source. No use in other products for resale. 6 months support. |
| Source file header (about 287 files) | `client/src/**`, `server/**`, `packages/diploy-core/**`, `shared/schema.ts`, `dist/index.js` | "Distributed under the Envato / CodeCanyon License Agreement." "NOT permitted to redistribute, resell, sublicense, or share." |
| Some server files, short tag only | `server/middleware/correlation-id.ts` ("@license Envato Regular/Extended License"), `server/seed-plivo-pricing.ts`, `server/seed-twilio-countries.ts`, `server/utils/errors.ts` | Refer to CodeCanyon/Envato. No full text. |
| diploy-core package | `packages/diploy-core/package.json` | License field says "SEE LICENSE IN LICENSE.md". No `LICENSE.md` exists in that folder. |
| Decision Engine | `server/engines/decision/` (LICENSE, NOTICE.md) | MIT, copyright Jason Lee, 2026. Copied from another repo. |
| Interaction Engine (offline part) | `server/engines/interaction/` (NOTICE.md, offline/) | Proprietary, copyright Masterleeaus, 2026. Full text is in another repo, not here. NOTICE says use is authorised but that is "not a licence grant". A written licence is needed before distribution beyond the owner. |
| Trust readiness | `server/engines/trust/` (NOTICE.md) | Proprietary, copyright Masterleeaus, 2026. NOTICE says the source repo's LICENSE applies. That LICENSE is not in this repo. |
| Field Link vendored code | `server/integrations/field-link/vendor/` (NOTICE.md) | No licence file. NOTICE says "Licence terms were not analysed." |
| DBOS (vendored) | `vendor/dbos/` (LICENSE, NOTICE.md, package.json) | MIT, copyright DBOS, Inc., 2023. |
| MCP gateway redaction code | `_TITAN_HANDOFF/NOTICES/mcp-gateway-work-MIT.md` | MIT, copyright Aureo Bueno, 2026. Notice says the copyright notice must stay with any ported code. |
| Chatbot builder scripts | `client/public/chatbot-builder/` (NOTICE.md) | Copied from another project. NOTICE says terms are in that project's `THIRD_PARTY_NOTICES.md`, which is not in this repo. Terms not written here. |
| Chatbot PWA scripts | `client/public/chatbot-pwa/` (NOTICE.md) | Copied from another project. No licence text in this repo. Terms not written here. |

Not reviewed in detail: the two `package.json` files under `_TITAN_HANDOFF/PASS11_GITHUB_DONORS/`, which have licence fields.

## Questions for the owner

1. Who is the copyright holder of the main product: Diploy / Bisht Technologies Private Limited, the individual author, or someone else?
2. Do the CodeCanyon / Envato terms allow the source to be released under MIT? If not, should the root `LICENSE` be replaced or removed?
3. Which files should be removed, re-licensed, or kept private? In particular: the CodeCanyon-header files, `server/engines/interaction/` and `server/engines/trust/` (proprietary), and `server/integrations/field-link/vendor/` (no licence).
4. Should the README "License" line and the root `package.json` "license" field be changed so they agree?
5. Where are the missing licence texts? (`packages/diploy-core/LICENSE.md`, the Interaction and Trust LICENSE files, the Clean-Hub `THIRD_PARTY_NOTICES.md`.)

## Next steps (no changes made yet)

- Owner answers the questions above, one at a time if needed.
- Then a separate change can update the licence files and headers.
- Issue #37 stays open until the owner decides.

## Scope of this brief

- Files read: `LICENSE`, `README.md`, `INSTALLATION.md`, the `package.json` files, the NOTICE and LICENSE files listed above, and grep results for CodeCanyon / Envato terms.
- No code was changed. No file was removed or re-licensed.
- Not legal advice. A qualified lawyer should review any decision about licences and copyright.
