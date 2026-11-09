# Marketing RLS policy invariants — Pass 12

PostgreSQL combines permissive policies by OR. Therefore the mere presence of a correct tenant-bound policy does not guarantee isolation if another permissive policy grants access to the same role or PUBLIC.

The activation check now requires an ALL-command permissive tenant policy for `desk_app`, with exact company predicates for both USING and WITH CHECK, and refuses additional permissive policies accessible to `desk_app` or PUBLIC. Extra RESTRICTIVE policies are allowed because they can only narrow access. Missing role or unknown policy metadata fails closed. This is a read-only preflight, not a migration.

Tests include PostgreSQL's `name[]` literal encoding, rendered policy expressions, permissive-policy bypass attempts and the actual rows from pg_policies in disposable PostgreSQL.
