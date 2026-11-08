# Titan Desk (AgentLabs) — Pass 7 cumulative source checkpoint

Contains the **actual original supplied Desk v5.4.5 backup source** plus
all **four accumulated Pass 3–5 bridge source files**, with `server/routes.ts`
now directly updated to register the simulation-only route.

## What is newly integrated
- `server/integrations/titan-field/{protocol,receiver,template-policy}.mjs`
- `server/integrations/titan-field/route.ts`
- `server/routes.ts`: import and `app.use(createTitanFieldBridgeRouter())`.
- `_TITAN_HANDOFF/FIELD_DONORS_FOR_ADAPTATION/`: **50 original Field communication donors** held **outside** Desk's compiler and routes. They are not active modules.

## Strict boundaries
- The route is disabled unless `TITAN_FIELD_BRIDGE_MODE=shadow`; **even then** it returns 503 until separately verified identity, consent and durable event ledger adapters are injected. No real provider delivery exists in this bridge.
- Database tables, migrations and connections are NOT integrated; handled by the other agent.
- The supplied Desk backup is incomplete for deployment: original root configs (such as `tsconfig.json`, `drizzle.config.ts` and `vite.config.ts`) were not supplied. Do not deploy it as a full replacement for `/home/admin/apps/desk`.
- Never copy `_TITAN_HANDOFF/FIELD_DONORS_FOR_ADAPTATION/` into live Desk code automatically.

## Application source preservation
The Desk source is byte-identical to the backup apart from `server/routes.ts`.
All historical Pass 3–5 bridge source files are byte-identical to Pass 5 FINAL.
