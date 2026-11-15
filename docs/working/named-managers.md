# Named Managers and the Skilled Manager (issues #49, #50)

Status: implemented as role definitions in the workforce catalogue, with tests. Not yet shown as a separate
screen in the Supercharged UI. The roster API lists them once a company has agents created from them.

## Hub, Go and Command Managers (#50)

Three separate agents. Each is a catalogue role in `server/workforce/catalogue/roles/`, validated by the same
loader as every other role. They share the workforce runtime and business tools. They do not share a tool
list beyond the safety escalation.

| Manager | File | Audience | Allowed tools (summary) | Refused, by design |
| --- | --- | --- | --- | --- |
| Hub Manager | `hub-manager.ts` | Customers, prospects, enquirers | Own client record, availability, booking and quote requests, complaints, reply drafts, safety escalation | Money, payments, invoices, staff, rosters, field execution, any customer send |
| Go Manager | `go-manager.ts` | Technicians and crews on their assigned jobs | Work orders, visits, checklists, job notes, photos, sign-off record, materials, sites, property issues, technician tasks, safety escalation | Invoices, payments, quotes, purchasing, supplier bills, staff pay, customer contact and sends |
| Command Manager | `command-manager.ts` | Business owner and approved managers | Schedules, rosters, timesheets, invoices, payments, quotes, purchasing list, reviews, inventory, compliance list, staff tasks, safety escalation, purchase order draft | Customer sends, refunds, payment plans, direct customer contact |

Rules that hold for all three:

- `companyScope` is `required`. The company is bound at runtime, never in the role file.
- Every write tool declares `write` access. Every money or customer-send tool is in the always-approval list and
  is `critical` risk. Command's purchase order draft is the only money tool any Manager holds.
- Each Manager escalates safety issues with `safety.escalate_to_human`.
- Handoffs: Hub goes to Go and Command, Go goes to Command, Command goes to Hub and Go.

Tests: `tests/workforce/named-managers.test.mjs` pins each Manager's exact tool set, its refused tools, its
access classes, the owner-approval rule and the handoff targets.

Escalation paths in plain words:

- Any safety, injury or hazard: the role tells the person to contact emergency services, then calls
  `safety.escalate_to_human`.
- Complaints and disputes from customers: Hub records a complaint and hands it to a person.
- Field questions about money or customer terms: Go hands to Command.
- Owner decisions (purchasing, rosters, reviews): Command prepares a draft or proposal and waits for approval.

## Skilled Manager (#49)

The learner-facing Academy assistant. It is built by `server/workforce/courses/skilled-manager.ts` and is
added only when `WORKFORCE_COURSE_ASSISTANTS` is on, together with the learner assistants it routes to.

- Tool: `course_knowledge.search`, declared `read`. No write tool.
- Routes each learner to the learner assistant for their service group (`assistant-<group>`).
- Guardrails: answers only from unlocked published lessons, never reveals answer keys or assessment answers,
  does not answer scored questions during an assessment, and points to a qualified person for safety-critical
  topics.
- Startup: `loadCatalogueAtStartup` (`server/workforce/catalogue/startup.ts`) calls
  `registerCourseAssistantRoles` only when the flag is on. The default is off, so boot is unchanged.

### Open for #49

- `course_knowledge.search` has no handler in `server/workforce/tools/`. A Skilled Manager cannot answer a
  learner until the retrieval handler exists. Learner identity and progression scope are not yet bound to that
  handler.
- The curriculum root (`ACADEMY_CURRICULUM_ROOT`, default `/home/claude/scan10/...`) is not in this checkout.
  The course generator and `courses.suite.mjs` cannot run here.
- The `course_knowledge.search` tool is not in `TOOL_ACCESS`. Adding it is blocked by a test that requires every
  `TOOL_ACCESS` entry to be declared by a role file in the default catalogue. The role's own `toolAccess` says
  `read`, which the runtime uses.
