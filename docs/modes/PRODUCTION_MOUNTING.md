# Inbox and Marketing: production integration contract

The first-class Inbox and Marketing Express adapters reuse existing business services and **never** instantiate in-memory stores in production. Their common adapter reads verified company and actor data exclusively from `res.locals`, after authentication and company-scope middleware.

The mounting point `registerOptionalCommsRoutes` is in `server/routes/core/optional-comms-routes.ts`. It is disabled by default. Set `COMMS_INBOX_ENABLED=true` or `COMMS_MARKETING_ENABLED=true` **only after** injecting real persistent services and promoting the corresponding database migrations. Startup throws when a flag is enabled without the dependency; mixed partial deployments fail before mounting either module.

Routes: `/api/comms/inbox` and `/api/comms/marketing`. Each request checks the configured Host, authenticated user, verified company, actor and role. Provider webhooks, persistent inbox storage and outbound deliveries remain out of scope; do not claim these modules are production ready.
