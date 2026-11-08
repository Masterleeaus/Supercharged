# Tool Handler Reconciliation

Read-only check, 2026-11-03. No code or checklist files were edited.

## 1. Contract-mapped IDs (vendor/workforce-native/contracts.ts)

The file maps six agents (reception, sales, booking, scheduling, jobs, customer_care) to 35 `op()` entries. These cover **27 unique tool IDs**, which map to **22 distinct REST path strings**.

Unique IDs: booking_requests.convert, booking_requests.create, booking_requests.get, booking_requests.list, booking_requests.update, clients.create, clients.get, clients.list, estimates.create, estimates.list, invoices.get, project_visits.bulk, project_visits.list, projects.get, projects.list, projects.transition, properties.list, property_issues.create, property_issues.list, property_issues.update, users.list, visits.get, visits.transition, visits.update, work_orders.complete, work_orders.list, work_orders.start_visit.

Paths: /api/v1/booking-requests (and /:id, /:id/convert), /api/v1/clients (and /:id), /api/v1/estimates, /api/v1/invoices/:id, /api/v1/jobs (and /:id, /:id/transition, /:id/visits, /:id/visits/bulk), /api/v1/properties (and /:id/issues, /:id/issues/:issueId), /api/v1/users, /api/v1/visits/:id (and /:id/transition), /api/v1/work-orders (and /:id/complete, /:id/start-visit).

## 2. Route check

Searched `server/` and `client/` for each path family (`/api/v1/clients`, `booking-requests`, `estimates`, `properties`, `jobs`, `visits`, `work-orders`, `users`, `invoices`, and the segments `start-visit`, `project_visits`, `property_issues`), excluding the contracts file and `vendor/`.

Result: **no matches for any contract path.** The only `/api/v1` hits are:
- `server/services/rag-knowledge.{ts,js}`: outbound OpenRouter base URL.
- `server/integrations/titan-field/local-link-topology.mjs`: `/api/v1/titan/desk-bridge/reply-proposals`.

Near miss: `server/integrations/field-link/client.ts` (lines 30 and 32) calls `/api/v1/integrations/desk/booking-requests` and `/:id`. These are outbound client calls to a different prefix, not served routes, and not in the contract.

## 3. Handler check for the 101 declared IDs

Each of the 101 IDs in the tool table of `docs/CAPABILITY_REGISTRY.md` was grepped as a literal across `server/`, excluding `server/workforce/catalogue/roles/` and `vendor/`.

Result: **3 distinct IDs hit, all documentation, 0 handlers.**
- `server/workforce/catalogue/SCHEMA.md`: clients.list, booking_requests.list, booking_requests.create (examples and schema text).
- `server/workforce/catalogue/role.schema.ts`: booking_requests.create (in a validation error message).

The other 98 IDs have no reference at all.

## 4. How the two scans relate

- Of the 27 contract IDs, **24 are in the registry's 101-ID tool table**. The earlier "24" figure is this overlap, not a count of Field service paths.
- The other 3 contract IDs are not declared by any role: booking_requests.convert, projects.transition, work_orders.complete.
- So the contract is not a strict subset of the 101. It is mostly a subset, plus 3 extra IDs.
- Both scans are consistent. The contract file is a declaration of intended operations against paths that do not exist in this repo. The registry finds no handlers for the declared tools.

## 5. Conclusion

No declared tool currently has a working handler in this app: 0 of 101 declared tools have a handler outside the role files, and none of the 22 contract REST paths is served from `server/` or `client/`.

Limits: this is a literal-string search. Routes assembled from pieces with no literal path would not show up, and `vendor/` was excluded by instruction, so an external Field service backend is not ruled out.
