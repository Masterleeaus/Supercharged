# SMTP TLS verification policy

Every SMTP transport, including test email and the administrator SMTP test endpoint, must authenticate the remote TLS certificate. The former process-wide `SMTP_ALLOW_SELF_SIGNED` setting is **not supported** because it silently disabled certificate validation for every tenant's SMTP credentials, which risks credential interception.

Use a publicly trusted certificate for the mail relay wherever possible. For a relay with a private certificate authority (CA), install a verified, independently obtained CA certificate in the host trust store, or configure the Node.js runtime with an audited file using `NODE_EXTRA_CA_CERTS=/path/to/approved-relay-ca.pem`. The file must be present before starting Node, readable by the application process, owner-controlled and updated when the CA rotates. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized:false`, an untrusted certificate copied from an unauthenticated handshake, or a wildcard trust exception.

## Operator verification

1. Confirm the SMTP host and port, and verify its certificate identity matches the configured hostname.
2. Establish the certificate-chain provenance from the relay operator via a trusted out-of-band channel; do not fetch a CA from the failing connection and blindly trust it.
3. Run the unit/runtime guard `node --test --experimental-transform-types tests/security/smtp-verified-certificates.test.mjs`. It checks default/legacy toggles, all transport call sites, a local self-signed server rejection, and an explicitly trusted private CA.
4. Test the real tenant SMTP credentials against a staging relay with verified TLS, including the admin **Test SMTP** path. Do not copy SMTP passwords or certificates' private keys into CI logs.
5. Re-run the affected suite after runtime upgrades. Require all CI/build and live-transport verification before closing security issue #3.

This policy does not claim that staging mail delivery, DNS/TLS setup or a live relay has been tested. It only establishes the source-level requirement and a repeatable local TLS handshake contract.
