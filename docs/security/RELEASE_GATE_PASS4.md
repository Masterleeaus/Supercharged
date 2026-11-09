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
