# Booking agent company scope

Read-only investigation. No source files were edited.

## Files

| File | Role |
|---|---|
| `server/modules/booking-agent/company-scope.ts` | Exports one function, `assertCompanyId(companyId: unknown)`. Accepts any non-empty string. Reads no request object. |
| `server/middleware/company-scope.ts` | Authoritative. Exports `CompanyScopeError`, `getCompanyScope(req)`, and `requireCompanyScope()`. Reads `req.user.companyId`, validates it with `isCompanyId` (UUID regex from `server/infrastructure/database/tenant-context.ts`), and fails closed. |

## Importers

Imports of the booking-agent `company-scope.ts`:

- `server/modules/booking-agent/dispatcher.ts` (line 1)
- `server/modules/booking-agent/memory-adapters.ts` (line 2)
- `server/modules/booking-agent/index.ts` (line 14, re-export)

Imports of `server/middleware/company-scope.ts` (for reference): `routes/crm-routes.ts`, `routes/template-routes.ts`, `routes/incoming-connections-routes.ts`, `routes/flow-automation-routes.ts`, `engines/twilio-openai/routes/twilio-openai-incoming-connections.ts`.

No route, router, or `routes.ts` mount imports `modules/booking-agent`. `createBookingAgent` and `.dispatch(` have no callers outside the module folder. `server/modules/desk-modes/mode-modules.ts` lists `'booking-agent'` as a workforce module name, but that file is data only. Nothing in the repo supplies `BookingCaller.companyId` at runtime.

## Behaviour comparison

| Aspect | booking-agent `company-scope.ts` | `server/middleware/company-scope.ts` |
|---|---|---|
| Exports | `assertCompanyId` | `getCompanyScope`, `requireCompanyScope`, `CompanyScopeError` |
| Source of company id | Argument passed in by caller (`BookingCaller.companyId`) | `req.user.companyId` |
| Reads body, query, params, headers | No (never sees a request) | No |
| Validation | `typeof string` and non-blank | UUID via `isCompanyId` |
| Missing company | Throws `TypeError` (fails closed) | `getCompanyScope` throws `CompanyScopeError`; `requireCompanyScope` returns 403 (fails closed) |
| Matches the other? | No. Looser check (any non-blank string), no request binding | Reference behaviour |

## Verdict

The middleware is authoritative. The booking agent does not use it. It uses its own `assertCompanyId`, which fails closed for missing or blank values but is weaker than the middleware: it accepts any non-empty string, not a UUID, and it does not read `req.user.companyId`. Neither version takes the company from the body or headers. The booking agent gets its company only from the caller object, so its safety depends on whoever builds `BookingCaller` honouring the same rule. No such caller exists in this repo yet (see PORT-MAP.md step 7), so the gap is latent, not live.

## Recommended change

Do not change the booking agent's `assertCompanyId` in isolation. When the booking routes are wired, the route layer should run `requireCompanyScope()` after `authenticate`, call `getCompanyScope(req)`, and pass the result into `dispatch()` as `caller.companyId`. At the same time, make the booking-agent `assertCompanyId` apply the UUID rule through `isCompanyId` from `tenant-context.ts`, so the port layer and the middleware agree on what a valid company is. Add a test that a non-UUID or missing company is refused at both layers. This paragraph is a recommendation only; no code was edited.
