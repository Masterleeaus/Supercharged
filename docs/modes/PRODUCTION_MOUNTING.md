# Inbox and Marketing: production integration contract

The first-class Inbox and Marketing Express adapters reuse existing business services and **never** instantiate in-memory stores in production. Their common adapter reads verified company and actor data exclusively from `res.locals`, after authentication and company-scope middleware.

The mounting point `registerOptionalCommsRoutes` is in `server/routes/core/optional-comms-routes.ts`. It is disabled by default. Set `COMMS_INBOX_ENABLED=true` or `COMMS_MARKETING_ENABLED=true` **only after** injecting real persistent services and promoting the corresponding database migrations. Startup throws when a flag is enabled without the dependency; mixed partial deployments fail before mounting either module.

Routes: `/api/comms/inbox` and `/api/comms/marketing`. Each request checks the configured Host, authenticated user, verified company, actor and role. Provider webhooks, persistent inbox storage and outbound deliveries remain out of scope; do not claim these modules are production ready.

## Service interface validation

Pass 7 adds a startup-time contract check for every route operation used by the first-class Inbox and Marketing routers. The check happens before any router mounts, including when both flags are enabled. This avoids deploying a partially implemented service interface. A green contract check does **not** prove that an implementation is persistent or that external delivery works.
