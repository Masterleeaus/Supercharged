# Marketing persistence threat model

**Trust boundary:** a signed session establishes company A or B; route-scoped service receives that tenant; the SQL store validates its UUID and pins a restricted database transaction with `withTenant`. Every record read and write includes `company_id = $1`. Database RLS is a required second layer, not yet verified by this pass.

**Attacks covered:** missing tenant, cross-tenant record ID, forged filter values, SQL injection through campaign IDs/body, client-provided database column names, reused pool connection settings, and rollback after errors.

**Not yet covered:** deployed DB roles and RLS, concurrent publish races, migration rollout and rollback, source-to-campaign foreign-reference validity, customer-facing hosting, unauthorized public reads, external channel delivery, and data retention. These must be tested separately with real tenant data.
