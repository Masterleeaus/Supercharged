# Inbox approval transactions — Pass 17

A service shared across multiple businesses cannot retain one company's transaction runner. Approval decisions must resolve a runner from the verified company ID **for each operation**. The `inboxTransactionsFor(pool)` factory creates company-specific transaction runners using `withTenant`; conditional approval claim and Inbox message/thread updates share one pinned PostgreSQL transaction. A callback using a different tenant ID throws and rolls back.

The verified production constructor now builds the runner factory from its injected pool rather than accepting a static runner from callers. `createInboxService` retains the legacy `transactions` option for isolated test helpers, while favouring `transactionsFor(companyId)` when supplied.

This does **not** provide a production approval policy, a transport sender or an active Inbox HTTP mount. Inbox continues to require those dependencies and a reviewed database migration before production activation.

## Pass 18: canonical approval claims

The canonical ApprovalService expects a full row when calling its `markExecuted(tx)`. Inbox's conditional SQL claim returns only a success marker. `createInboxApprovalPort` resolves the API mismatch by pre-reading and validating the canonical approval within the same company, then calling the existing transaction-scoped claim and returning the verified snapshot only when the claim succeeds. The adapter audits after commit using the canonical ApprovalService. It never authorizes a nontransactional claim.
