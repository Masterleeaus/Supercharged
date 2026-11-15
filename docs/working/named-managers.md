# Named Managers and the Skilled Manager (issues #49, #50)

Status: implemented as role definitions in the workforce catalogue, with tests. `catalogue/named-managers.ts`
gives the Supercharged surface one directory entry per Manager (name, audience, entry point, responsibilities,
escalation path) and fails closed if a Manager is missing or renamed. Still not a separate screen in the
Supercharged UI: the directory is not yet rendered, and the roster API lists a Manager once a company has an
agent created from it.

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
access classes, the owner-approval rule and the handoff targets. `tests/workforce/named-manager-surface.test.mjs`
checks the directory against the real catalogue and that a company's Manager agents are invisible to another
company in the roster.

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

### #49 progress

- `courses/knowledge/course-search-tool.ts` builds the read-only `course_knowledge.search` tool over the shared
  retrieval path. Identity comes only from the verified context; params cannot name a learner or company. Tested
  in `tests/workforce/course-search-tool.test.mjs` with a fake port. It is not registered yet.
- The existing course search port (`courses/store/search-port.ts`) already re-checks enrolment, tier unlock,
  assessment state and answer-material screening.

### Open for #49

- No learner-context reader and no revision store are bound to the LMS database. The tool and port cannot
  answer a real learner until both exist and the tool is registered. Registration also needs
  `course_knowledge.search` added to `TOOL_ACCESS`, which the test that requires every `TOOL_ACCESS` entry to be
  declared by a role file allows once the Skilled Manager is in the default catalogue. The Skilled Manager
  itself is built only in the flag-on path.
- The curriculum root (`ACADEMY_CURRICULUM_ROOT`, default `/home/claude/scan10/...`) is not in this checkout.
  The course generator and `courses.suite.mjs` cannot run here.
- Decision: the Skilled Manager stays flag-gated (`WORKFORCE_COURSE_ASSISTANTS`, default off). Its learner
  assistants stay separately selectable and are also routed through the Skilled Manager, so a learner can reach
  a service-group assistant either way. Both paths use the same read-only tool.
