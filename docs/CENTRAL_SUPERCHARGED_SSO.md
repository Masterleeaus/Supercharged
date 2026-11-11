# Supercharged — Central SSO adapter integration

Central issue #25 requires real Supercharged authentication with its own
existing user IDs and company context. This pass adds a disabled, server-only
central selection validator, exact company/identity resolution adapter,
tenant-scoped PostgreSQL lookup, and wrapper for the existing native JWT
issuer. Existing user login is unchanged.

The resolver requires an independently verified Central issuer/subject,
current company mapping, live product entitlement, exactly one local
`desk_central_identity_links` row, a current user-company match, and an
active account. Company context travels through the existing `withTenant`
transaction, which sets `app.company_id` and a restricted role.

The optional migration is intentionally **not applied**. Verify live
Supercharged `users` schema, actual tenant role, SQL function ownership and
migration runner before applying it; no direct product connection is
enabled. Never accept browser-controlled `authority:'central-verified'`
as true authentication: that value must be produced internally only after
the actual OIDC callback and Central access check.

Outstanding: real OIDC/PKCE callback, verified company selection, durable
company-linked token revocation, upstream client registration, and
end-to-end tenant separation. Do not close issue #25 or bypass native login.
