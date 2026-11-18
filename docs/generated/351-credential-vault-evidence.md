# #351 Per-company credential vault and OAuth connect flow: evidence

Base: main at 3c275bef. Run: `node --test --experimental-transform-types tests/connectors/vault.test.mjs tests/connectors/connector-admin.test.mjs` gives 22 pass, 0 fail.

## Checklist

- [x] Encrypted per-company storage with key versions. Evidence: `server/connectors/vault/credential-vault.ts`. Test: `tests/connectors/vault.test.mjs` "credentials round trip, are scoped to one company and one connector, and never sit in plain storage".
- [x] Invalid credential shapes are refused before storage. Test: "invalid credential shapes are refused before anything is stored".
- [x] Credentials never appear in URLs, logs or the audit trail. Tests: "credentials are not in any URL the flow builds, and the flow module never logs" and the connector admin tests.
- [x] Rotation: old rows still decrypt after a key-version change and re-saving moves them to the new version. Tests: "rotation: old rows still open after a key-version change" and "a key version missing from the keyring fails closed with a generic error".
- [ ] OAuth 2.0 connect, callback, refresh and revoke for providers that support it, and API-key entry for the rest.
  - Generic flow is implemented and tested: `server/connectors/vault/oauth-flow.ts` (PKCE S256, state, callback, refresh with skew and single-flight, revoke). Tests: "connect", "callback", "refresh" (two tests) and "revoke" in `tests/connectors/vault.test.mjs`.
  - Not done: no production provider is wired. `createOAuthFlow` is only called from tests. Real OAuth client IDs and secrets for the catalog providers (google-calendar, outlook-calendar) are needed from a live account. That is a credential step and is not done here.
  - API-key entry path is covered by the vault round-trip test and the connector admin tests.

## Blocker

Wiring a real OAuth provider needs client credentials from the owner. Until then this box stays unchecked and the issue stays open.
