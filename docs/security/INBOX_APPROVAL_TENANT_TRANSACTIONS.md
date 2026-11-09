# Inbox approval transactions — Pass 17

A service shared across multiple businesses cannot retain one company's transaction runner. Approval decisions must resolve a runner from the verified company ID **for each operation**. The `inboxTransactionsFor(pool)` factory creates company-specific transaction runners using `withTenant`; conditional approval claim and Inbox message/thread updates share one pinned PostgreSQL transaction. A callback using a different tenant ID throws and rolls back.

The verified production constructor now builds the runner factory from its injected pool rather than accepting a static runner from callers. `createInboxService` retains the legacy `transactions` option for isolated test helpers, while favouring `transactionsFor(companyId)` when supplied.

This does **not** provide a production approval policy, a transport sender or an active Inbox HTTP mount. Inbox continues to require those dependencies and a reviewed database migration before production activation.
