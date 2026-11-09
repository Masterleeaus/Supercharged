# Inbox production route activation — Pass 19

The actual Workforce/Comms route registrar now constructs the Inbox service when `COMMS_INBOX_ENABLED=true`. Startup verifies the existing Inbox schema and restricted-role RLS policies before mounting the authenticated Inbox HTTP router. The service reuses `createSqlInboxStore`, the company-scoped SQL transaction factory and the canonical ApprovalService (through its adapter). No in-memory fallback is used.

The route composer validates common authentication, role and company-scope middleware before touching PostgreSQL. When both Inbox and Marketing are enabled, both services must verify successfully before either route is mounted. An invalid or missing schema causes startup failure, rather than a partial mount.

**Do not enable on production yet.** The Inbox RLS migration is still a reviewed candidate, and outbound provider delivery is not implemented. Enabling before the migration is deployed will prevent startup. Production approval-table privileges, complete policy audit and provider transport require separate verification.
