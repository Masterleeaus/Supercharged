# Titan Runtime Authority

Browser-native authority boundary for workforce actions.

- `company_id` is Titan's canonical logical company identity and authority/evidence binding. Provider-local physical isolation may add stronger boundaries (for example per-company Frappe sites/databases) without replacing `company_id`.
- Identity, role, module, model and activation never grant authority.
- Titan Autonomy owns verified effective authority.
- Offline/degraded runtime may only contract authority.
- Consequential mutation requires governed Command Bus/ExecutionGateway preparation, a provider execution receipt bound to the current authority decision, and observed post-action verification before the **business outcome** may be marked VERIFIED. A successful execution receipt/provider ACK is not itself verified business reality.

## Ownership

This package is the canonical runtime authority/effective-execution boundary. DirectAdmin #1056 is its operator cockpit, not a second authority engine. Workforce Trust/unlock gates may establish eligibility for authority evaluation but never grant execution authority. Frappe/DirectAdmin/root/model/provider identity never bypasses this runtime.
