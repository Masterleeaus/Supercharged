# Communications scope boundary — Pass 4

All communications routes must use a **server-resolved** authenticated company and actor. A route-level scope resolver returning an invalid UUID, absent actor, unknown actor kind, or blank actor ID is denied before business logic runs. A throwing scope resolver is also denied without revealing internal exception messages.

The browser's body, query, path and forwarded host are not tenancy authorities. The canonical company is the verified session claim. This is defensive validation at the shared router boundary, **not** a substitute for auth middleware, database tenant filters, row-level controls or provider signature validation.

Only `human` and `agent` actor kinds are valid. Both require a nonblank actor identifier. A successful service call still requires the existing role, mode and company checks.

Tests: `tests/modules/comms-router.test.mjs`, `tests/security/comms-scope-boundaries.test.mjs`, and the three concrete router test suites.

## Express production bridge

The shared Express adapter explicitly copies `res.locals` (set by verified session middleware) into the request view used by the existing comms service routers. It never reads tenant IDs or actor IDs from HTTP parameters. Mounting requires authentication, company-scope validation, and module/role checks. The new HTTP integration test exercises the actual Express request chain with two companies and an unknown Host.
