# Inbox security readiness gate — Pass 16

`verifyInboxSchema` inspects the actual PostgreSQL deployment catalog without making database changes. It checks desk_app is neither superuser nor RLS bypass; all **four** existing Inbox tables have ENABLE and FORCE RLS; the restricted role has SELECT/INSERT/UPDATE; and each table has an ALL-command tenant policy with complete read/write predicates. Extra permissive policies are refused, because PostgreSQL OR-combines them.

`createVerifiedInboxService` requires an explicit PostgreSQL pool, schema inspector, approval port and atomic transaction runner. It refuses missing security and never substitutes in-memory persistence. The constructor is opt-in and does not mount Inbox or enable sends.

The approval port and transaction runner remain an integration boundary requiring tenant-correct per-request composition for multi-company traffic. No production route is activated in this pass. The PostgreSQL CI job verifies catalog readiness and inbound-service deduplication on a disposable database.

## Pass 17: company-scoped approval runner

The verified production constructor now derives per-company atomic approval runners from the injected PostgreSQL pool. No caller may supply a fixed-company runner for a shared production service. The approved-send path selects the transaction from the validated company ID before attempting the approval claim; wrong-company updates fail and roll back.

## Pass 18: ApprovalService composition

The verified Inbox service constructor accepts `approvalService`, converting the existing canonical approval engine into an Inbox approval port. The adapter insists on company-scoped reads, transactional claim and post-commit execution audit. Forbid supplying both `approvals` and `approvalService`, which would create ambiguous policy ownership. This does not activate Inbox transport or its routes.

## Pass 19: startup route isolation

The asynchronous verified comms route composer validates authentication, role and company guards, then creates enabled services before installing any HTTP route. If either Marketing or Inbox is enabled and its readiness check fails, neither route mounts. The Inbox database remains subject to a reviewed migration candidate, so production activation is still prohibited.
