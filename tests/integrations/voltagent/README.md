# VoltAgent integration tests

Tests for the VoltAgent workstreams. Shared helpers live in `_helpers/`.

## Shared helpers

Helpers are plain `.mjs` files with no runtime imports. They never import `@mastra` or any `ee/` path.
A test checks this rule (see `_helpers/helpers.test.mjs`).

- **fake-chat-provider.mjs**: a scripted chat provider. Give it a list of replies. A reply is either text, or
  a failure with an HTTP status such as 503 or 429, or a transport failure (no status). Use `failWith` to make
  every call fail with one status, for failover tests. Every call is recorded in `calls`. When the script runs
  out, it fails without retry.
- **fake-registry.mjs**: a small in-memory tool registry with the same method names as the real one
  (`register`, `has`, `list`, `invoke`). It checks the company id, the actor, the tool id and the params, then
  runs the handler. It does not check policy, approvals, freshness or idempotency. Every call is recorded in
  `calls`, refused ones too. `callTool` is the same as `invoke`.
- **fixtures.mjs**: plain test data. A default company id (`co-test-1`) and a second one for cross-tenant checks.
  Agent and human actors. Run budget, retry policy and budget limits. A team builder that returns a team input
  and a role source, ready for the real `createTeam`.

## Running

Run each test file by name:

    node --test tests/integrations/voltagent/_helpers/helpers.test.mjs
