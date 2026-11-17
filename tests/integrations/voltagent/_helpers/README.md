# VoltAgent test helpers

Shared fakes and fixtures for `tests/integrations/voltagent/`. Nothing here is a test file, so
`node --test` does not run it directly.

- `createFakeChatProvider(script)`: scripted replies, records every request, throws when the script runs out.
- `createFakeRegistry(tools)`: plain-function tools, records each invocation, throws on unknown names.
- `TENANT_A`, `TENANT_B`, `agentRunFixture()`: two tenants for isolation tests.

Run a test that uses them: `node --test --experimental-transform-types tests/integrations/voltagent/<file>.test.mjs`
