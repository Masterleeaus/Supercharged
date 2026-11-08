# Approvals port notes: Interaction Engine authority and signing

Source: `/home/claude/scan-gh/Interaction-engine` (PHP Laravel plus TypeScript offline companion).
Ported as pure TypeScript. No PHP is vendored, and no engine text is copied beyond short identifiers.

## Files

| File | What it is |
| --- | --- |
| `authority-ladder.ts` | Table-driven ladder: `(autonomy level, risk tier, approval state, actor)` to `allow`, `require_approval` or `deny`, with a reason. |
| `approval-signing.ts` | HMAC-SHA256 signing of an approval decision, `timingSafeEqual` verification, secret checks, and `hashAction`. |
| `../../../tests/modules/authority-ladder.test.mjs` | 45 `node:test` cases. Every ladder cell, fail-closed inputs, signing round-trip, tampering, secret refusal. |

## What was ported

- The ladder now has the four owner-decided autonomy tiers, least to most autonomous: `assist`, `suggest`, `auto`, `predictive`. They match the rank order in `role.schema.ts`. Assist runs no tools. Suggest runs read tools at every tier with no approval gate, and denies every write tool. Auto and predictive run low and medium tiers, and wait for owner approval at high and critical. `user_only` is the verified human actor, not a tier. The engine's six `AuthorityLevel` values were collapsed into these four.
- The engine's ladder behaviour: observe, recommend and prepare levels cannot execute; approval-required actions need a verified approval; user-only actions need a human actor (`PolicyEngine::decide`).
- The fail-closed rule for unknown capabilities and unknown levels (engine: `unknown_capability_denied`).
- The approval-grant signing idea: HMAC-SHA256 over a canonical encoding, verified with a constant-time comparison (`ApprovalSigner`).

## What was not ported, and why

1. **Placeholder secret fallbacks.** `config/interaction.php` line 23 falls back to `'change-me'` and line 38 to `'change-this-approval-secret'`, both via `APP_KEY`. Desk must not default to `APP_KEY` or any literal. `assertApprovalSecret()` refuses the engine's placeholders, the eval fixture secret `interaction-policy-eval-secret-2026`, and any secret under 32 characters. The composition root should call it at boot and stop if it throws.
2. **Bare SHA-256 key derivation.** `resources/ts/offline/crypto.ts` `deriveKey()` uses the SHA-256 digest of the secret as the AES key, with an 8-character minimum. No encryption was ported. If the offline outbox is ported later, it needs a salted KDF (HKDF or scrypt) and a 32-character minimum.
3. **16-character minimum.** `ApprovalSigner.php` line 11 accepts 16. Desk uses 32.
4. **PHP canonical encoding.** The engine calls `ksort` on the top level only, then `json_encode`. Nested keys are not sorted. The signed payload here is a different structure (a JSON array with a domain tag), so PHP grants will not verify in TypeScript and the reverse. This is intentional and avoids silent cross-language confusion.
5. **Fresh authentication, delegated scopes, numeric limits, custom policy callbacks** (`PolicyEngine.php`). Not in the ladder. They belong to capability policy. Numeric limits map onto Desk's existing `$lte` rule matchers. Fresh authentication needs an auth timestamp from the verified session.
6. **Risk scoring** (`RiskEngine.php`: financial value over 10000 scores 20, new customer scores 10). Not ported. The engine has no risk tiers, so the caller assigns the tier.
7. **PHP-only machinery:** enums, readonly value classes, the Laravel config and environment layer, the command bus, and the cognitive event stream.

## Decisions for review

These are design choices, not engine behaviour.

- **Risk tiers** `low | medium | high | critical` are new. The engine has none.
- **Delegated autonomy:** `auto` and `predictive` agents may run `low` and `medium` actions alone. `high` and `critical` need a verified owner approval. `suggest` agents run read tools at every tier with no approval gate, and deny write tools. `assist` agents run no tools.
- **`user_only` (`HUMAN_ACTOR`):** an actor, not a tier. An agent claiming it is denied. A verified human actor runs `low`, `medium` and `high` actions, and `critical` still needs a verified owner approval. The caller sets `actorIsHuman` from its verified identity. This function does not check fresh authentication.
- **Approval does not override a deny.** `assist` cells, `suggest` cells for write tools, and an agent claiming `user_only` deny regardless of `humanApproved`.

## Mapping engine concepts to Desk approval states

Desk states are `pending | approved | rejected | expired` on `approvals.status`, with `decision`, `decidedBy`, `decisionReason`, `expiresAt` and `executedAt`.

| Engine concept | Desk equivalent |
| --- | --- |
| Ladder `allow` (low or medium cells for `auto`, `predictive` and `suggest` reads, or a verified human at low to high) | Gate result `approved`, `decision = auto_approve`. Matches the existing `statusForDecision` mapping. |
| Ladder `require_approval` (approval cells: `auto` and `predictive` at high and critical, a human at critical; `suggest` reads need no approval at any risk) | `pending`, `decision = route_to_human`. Waits in the human queue. |
| Ladder `deny` (`assist` at any tier, `suggest` write tools at any tier, unknown inputs) | `rejected`, `decision = auto_deny`, `decidedBy = policy:<ladder>`, `decisionReason` = ladder reason. |
| `user_only` claimed by an agent | `rejected`, `decision = auto_deny`, with the ladder reason that an agent cannot claim the human actor. |
| Signed grant from a human (`approved_by`, `approved_at`, `expires_at`, `signature`) | `decideApproval()` setting `approved` with `decidedBy` and `decidedAt`, plus a decision signature over `approvalId`, `actionHash`, `deciderId` and `decidedAt`. |
| Grant TTL (`expires_at`, policy TTL cap) | `expiresAt` on the row. `decideApproval` already refuses rows past their deadline. |
| Verification before execution | `verifyApprovalDecision()` on the stored signature. Only then is `humanApproved = true`. |
| Action has run | `executedAt`. The engine has no equivalent. |

## What the approvals module must call

1. **At boot:** `assertApprovalSecret(process.env.<APPROVAL_SECRET>)`. Stop if it throws. Do not fall back to `APP_KEY`.
2. **In `ApprovalService.gateAction`** (`approval-service.ts`), before the policy engine's `auto_approve` is honoured:
   - `hashAction(action, params)` to get the action hash.
   - `humanApproved` is `true` only when the row is `approved` and `verifyApprovalDecision({approvalId, actionHash, deciderId: decidedBy, decidedAt}, storedSignature, secret)` returns true.
   - `evaluateAuthority({ tier, autonomy, humanApproved, actorIsHuman, access })`. Pass `access` (`'read'` or `'write'`) for every tool, because `suggest` decides on it.
   - Ladder `deny` forces `auto_deny`. Ladder `require_approval` blocks `auto_approve`. Ladder `allow` leaves the policy result in place.
3. **In `ApprovalService.decideApproval`:** after the status update, call `signApprovalDecision` and persist the result. This needs a new nullable `decision_signature` column. `schema.ts` and the SQL draft are outside this port, so the column must be added in a separate, reviewed change.
4. **Tenant binding:** the signature does not cover `companyId`, `capability` or the grant's expiry. Tenant and action must come from the row lookup (`company_id` and `action` in the same query). Replay onto another row is blocked because `approvalId` is signed. The same row cannot be decided twice, because `decideApproval` only updates rows still `pending`. Extend the signed payload if a grant has to travel outside the database.

## Verification

`node --test tests/modules/authority-ladder.test.mjs`: 45 tests. The file imports `.ts` directly, as `approvals-policy.test.mjs` does, which Node 22.23 supports by default.
