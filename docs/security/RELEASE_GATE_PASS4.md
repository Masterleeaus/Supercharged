# Release gate — Pass 4

The following must pass before considering #52 complete:

1. CI unit suite, build and Docker smoke test on the exact head SHA.
2. Company A and company B tests against the *real* storage adapters, not only recording or in-memory fakes.
3. Authenticated and unauthenticated tests for the actual mounted Inbox, Marketing and Campaigns APIs.
4. Unconfigured Host, repeated Host, forwarded-host and malformed-port denial tests.
5. Verify the enabled chatbot staff inbox has real dependencies, safe role checks, and no no-op customer delivery presented as successful delivery.
6. Check legacy campaign and messaging routes for separate authorization paths; this pass does not claim to guard those paths.
7. Full TypeScript backlog remains separately tracked and is not resolved by these changes.

No live third-party provider or two-tenant database integration was exercised in this pass. Keep #52 open.

## Follow-up from Pass 4 CI

The first Pass 4 test run exposed 21 failures caused by a pre-existing test fixture using pseudo-tenant ID `c1`. The test fixture is repaired on the Pass 4 branch, preserving strict UUID validation. The full test suite must pass on the newer commit before these changes can be merged.

## Pass 6 production mounting gate

Inbox and Marketing now have real Express router factories and an optional route registration point. Both are **disabled by default**. To enable them, supply persistent, migration-compatible storage and verified authentication, then pass the HTTP cross-company isolation tests against that storage. Enabling a module without its required service intentionally fails startup rather than silently falling back to in-memory data.
