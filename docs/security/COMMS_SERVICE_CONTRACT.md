# Comms service activation contract (Pass 7)

An enabled Inbox or Marketing module must have a complete callable service interface. `assertServiceContract` checks every operation actually used by its router **before the first route is mounted**. Reject truthy placeholders, incomplete mocks, or missing methods at startup. Both modules are disabled by default.

The presence of all methods is **not** proof of durable persistence, migrations, third-party channel delivery or correct business behavior. Production activation additionally requires data-migration promotion, real store wiring, provider transport, tenant isolation against two real companies and a green exact-commit CI run.

The tests in `tests/integration/comms-service-contracts.test.mjs` and `tests/integration/comms-optional-contracts.test.mjs` exercise this startup boundary.
