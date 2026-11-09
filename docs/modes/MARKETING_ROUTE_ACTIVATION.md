# Verified Marketing route activation

Pass 13 introduces `registerVerifiedCommsRoutes`, which builds a real SQL-backed Marketing service only when `COMMS_MARKETING_ENABLED=true`. It checks the current schema/RLS permissions **before** registering any route, reuses the canonical ChatbotStorage for chatbot references and denies campaign links until the new Campaigns schema is promoted. Do not reuse the legacy voice-call campaigns table: its schema is incompatible.

Production `registerWorkforceCommsRoutes` now calls this verified async registration instead of the old sync mount directly. With the flag disabled the service is not created and no Marketing table access is attempted. Enabling without the reviewed migration/RLS causes startup failure (fail closed); a correctly migrated environment can expose the authenticated communications Marketing routes.

Inbox remains opt-in and cannot mount without its own durable service. Do not enable the Marketing flag in an un-migrated environment.
