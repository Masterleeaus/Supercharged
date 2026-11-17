# SuperchargedAt.Work — communications, AI workforce and business connectors

**Repository:** `Masterleeaus/Supercharged` · **Document review:** 18 November 2026 · **Package:** `agentlabs` (legacy internal identifier, retained for compatibility)

Supercharged is Titan Zero's communications, marketing automation, chatbot, customer engagement and governed **AI workforce** application. It supports the shared Titan Zero ecosystem but is **not** a second booking engine, training platform, or jobs authority.

**Readiness:** large inherited and new source surface, with implementation and verification at different stages. The existence of a UI, route, dependency, agent definition or provider adapter **does not certify a working end-to-end capability**. Confirm the actual module, tests, tenant isolation, consent and provider credentials before promoting a feature as released. See [STATUS.md](STATUS.md), [current issues](https://github.com/Masterleeaus/Supercharged/issues?q=is%3Aissue+is%3Aopen) and [#317](https://github.com/Masterleeaus/Supercharged/issues/317).

## Product scope and user outcomes

| Capability family | Responsibility / desired outcome | Open acceptance |
| --- | --- | --- |
| Inbox and customer conversations | Consolidated human messages, replies, assignment, history and audit receipts | [#22](https://github.com/Masterleeaus/Supercharged/issues/22), [#337](https://github.com/Masterleeaus/Supercharged/issues/337) |
| AI Assistant and hosted Agent Team | Knowledge-grounded conversations, authorised tool actions, approvals/escalation, specialist agent roles and outcomes | [#318](https://github.com/Masterleeaus/Supercharged/issues/318), [#329](https://github.com/Masterleeaus/Supercharged/issues/329), [#334](https://github.com/Masterleeaus/Supercharged/issues/334) |
| Voice and messaging | Plivo/Twilio/ElevenLabs/OpenAI provider adapters, calls, missed-call follow-up and consent-safe SMS/email | [#319](https://github.com/Masterleeaus/Supercharged/issues/319), [#328](https://github.com/Masterleeaus/Supercharged/issues/328), [#338](https://github.com/Masterleeaus/Supercharged/issues/338) |
| Campaigns and marketing | Lead qualification, reactivation, review invitations, follow-up, contact suppression and attribution | [#336](https://github.com/Masterleeaus/Supercharged/issues/336), [#360](https://github.com/Masterleeaus/Supercharged/issues/360), [#361](https://github.com/Masterleeaus/Supercharged/issues/361) |
| Customer chatbot mode | A tenant-grounded **Synced** customer-chatbot builder mode, sharing the existing agent/knowledge architecture rather than a duplicate engine | [#48](https://github.com/Masterleeaus/Supercharged/issues/48), [#335](https://github.com/Masterleeaus/Supercharged/issues/335) |
| Connector framework | Manifest registry, SDK, per-company OAuth/credential vault, sync/replay, calendar, payments, field-service and messaging integration | [#349](https://github.com/Masterleeaus/Supercharged/issues/349)–[#359](https://github.com/Masterleeaus/Supercharged/issues/359) |
| Governance and execution | Real, schema-validated tool handlers with declared risk, consent, company scope, idempotency and human approval | [#364](https://github.com/Masterleeaus/Supercharged/issues/364), [#365](https://github.com/Masterleeaus/Supercharged/issues/365) |

The 2026-11-17 connector and VoltAgent issue groups represent **plans and PR branches**, not a complete production connector store or agent runtime. Reconcile donor-source terms and approved licensing before redistributing any imported agent framework.

## System boundaries

- **Central:** Logto-backed OIDC, canonical company and membership, entitled hosted services, shared migration authority and signed cross-product decisions.
- **Scheduled:** the integrated authoritative booking calendar and deterministic availability/commit engine. Agents may request approved booking actions, never directly overwrite calendar state.
- **Sorted:** customers, jobs, estimates, field execution and invoicing. Communications may reference jobs but must not become a second jobs database.
- **Skilled:** course publication, learning, staff competencies and training eligibility. Suggestions do not confer qualifications.
- **Scheduling & Enquiries Manager:** the **single WordPress plugin** that continues deterministic local Free booking; hosted AI Assistant and Agent Team upgrade in that plugin's own admin. Supercharged provides hosted communications/agent capabilities only when the signed tenant-scoped contract and consent exist. **No separate Front Desk Pro installation.**

[Central ADR-009](https://github.com/Masterleeaus/Central/blob/main/TITAN_ARCHITECTURE_DECISIONS.md) mandates the **target** of one physical PostgreSQL database, distinct least-privilege product identities and one ordered migration ledger. Existing Drizzle migrations and standalone assumptions must be reconciled, not indiscriminately pushed to a shared production database. [#51](https://github.com/Masterleeaus/Supercharged/issues/51), [#127](https://github.com/Masterleeaus/Supercharged/issues/127), [#253](https://github.com/Masterleeaus/Supercharged/issues/253) and [Central #140](https://github.com/Masterleeaus/Central/issues/140) track this acceptance.

## Architecture and code map

| Path | What to inspect |
| --- | --- |
| `server/` | Express API, plugin loader, auth, communications providers, messaging/inbox, AI and booking-tool adapters |
| `server/plugins/` | Plugin manifest and loading/enablement safeguards |
| `server/engines/` | Voice/telephony engines, provider adapters and reusable engine contracts |
| `server/modules/` | Feature modules, customer widgets, chatbot and workflow ownership |
| `client/` | React/Vite application, tenant/admin and agent UI |
| `shared/` | Shared Drizzle schema, types and domain contracts |
| `migrations/` | Existing migration chain; coordinate with Central before integrated deployment |
| `tests/`, `scripts/` | Security, routing, typecheck, fresh-database and provider sandbox harnesses |
| `docs/`, `source/`, `vendor/` | Operational guidance and preserved upstream/donor material; inspect licence notices |

Internal `agentlabs`, historical provider names and compatibility identifiers may remain until an evidenced migration. Do not strip copyright/CodeCanyon/third-party notice files as a refactor shortcut; review [#395](https://github.com/Masterleeaus/Supercharged/issues/395) and open licensing PRs.

## Local developer commands

The root manifest requires **Node.js 22.13+**. Run only with a configured **disposable** PostgreSQL and appropriately isolated test credentials.

```bash
npm ci
npm run dev
npm run build
npm run lint
npm run check
npm run typecheck:strict
npm test
# Run only on an explicitly disposable, configured database:
npm run boot:check
```

`npm run db:migrate` invokes the safe migration runner; `npm run db:push` exists for compatibility but **must not be used as an unreviewed shared-production schema update**. For production, inspect [INSTALLATION.md](INSTALLATION.md) and the actual migration/CI acceptance first. Secrets belong in approved secret storage; never place provider keys, signed webhook credentials or live tokens in repo docs, workflow YAML, URL paths or query strings.

## Security and delivery gates

1. **[CI reconciliation #317](https://github.com/Masterleeaus/Supercharged/issues/317)** / [#398](https://github.com/Masterleeaus/Supercharged/issues/398): reconcile overlapping PRs, TypeScript strictness, boot migration failures, genuine full `npm test` failures, fresh PostgreSQL and tenant RLS before merging.
2. **[Route-auth #320](https://github.com/Masterleeaus/Supercharged/issues/320):** inventory every public/protected route, prove guards, scopes and abuse controls; never bulk-allowlist routes just to satisfy tests.
3. **[Webhook secrets #343](https://github.com/Masterleeaus/Supercharged/issues/343)** / [#2](https://github.com/Masterleeaus/Supercharged/issues/2) / [#3](https://github.com/Masterleeaus/Supercharged/issues/3): remove secret-bearing URLs/archives, rotate exposed live secrets if applicable, require signed fresh replay-safe deliveries and verified SMTP TLS.
4. **[Voice routing #319](https://github.com/Masterleeaus/Supercharged/issues/319)** / [#338](https://github.com/Masterleeaus/Supercharged/issues/338): static route-order contracts exist, but provider authentication, real callback dispatch and consent/failover scenarios remain operational tests.
5. **[Widget trust #324](https://github.com/Masterleeaus/Supercharged/issues/324):** origin allowlists are embedding controls, not cryptographic caller identity; enforce tenant-safe signed sessions, budgets, correct auth and negative cases.
6. **[Agent tools #364](https://github.com/Masterleeaus/Supercharged/issues/364)** and [#318](https://github.com/Masterleeaus/Supercharged/issues/318): no placeholder handler can count as an executable production agent; test approvals, denial, retries, receipts and tenant boundaries.

A small dedicated [security source-contract workflow](.github/workflows/security-source-contracts.yml) tests plugin enablement, scoped knowledge search and Plivo route order. **Passing those static checks does not override the failing full PR checks.** Full migration and provider tests are separate release gates.

## Roadmap and issue policy

Read the [current feature/connector epic #365](https://github.com/Masterleeaus/Supercharged/issues/365), [VoltAgent staging phase #392](https://github.com/Masterleeaus/Supercharged/issues/392) and [all open issues](https://github.com/Masterleeaus/Supercharged/issues?q=is%3Aissue+is%3Aopen). Every open issue should decompose into actionable Markdown tasks. Check `[x]` only when source and appropriate tests prove completion. Close duplicates only after transferring distinct unfinished acceptance to an authoritative open issue. **Deployment, licensed redistribution and hosted service availability have not been certified by this README.**
