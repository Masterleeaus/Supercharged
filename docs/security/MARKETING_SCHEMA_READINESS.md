# Marketing database activation gate (Pass 11)

The PostgreSQL integration tests validate data isolation on a disposable database. Production startup needs an additional, read-only security check against the actual database configuration. `verifyMarketingSchema` inspects the restricted `desk_app` role, both Marketing tables, FORCE RLS, required permissions, and tenant-specific policies for reads and writes. It returns an explicit readiness report. `requireMarketingSchema` rejects missing protections.

`createVerifiedMarketingService` refuses missing PostgreSQL, campaign and chatbot reference ports and requires this schema check to pass before constructing a MarketingService. It does not turn the existing feature flag on or deploy a migration. The probe connection must be configured separately from tenant-scoped application reads and must have permission to inspect PostgreSQL catalog metadata.

Neither callable service methods nor a successful schema inspection proves that external references or real production user sessions are configured. Keep COMMS_MARKETING_ENABLED disabled until those ports and operational controls are integrated and verified.

## Pass 12: composite-policy risk

PostgreSQL OR-combines PERMISSIVE RLS policies. The readiness verifier now audits all policies on both tables: it requires the expected ALL-command tenant restriction with exact PostgreSQL-normalized USING and WITH CHECK predicates, and denies any additional permissive rule accessible to desk_app or PUBLIC. Extra restrictive policies are allowed. A missing application role is handled without relying on privilege checks that assume the role exists.
