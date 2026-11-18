# SMTP TLS verification

All SMTP connections (primary and fallback transports, test email and the admin SMTP test route) verify the relay certificate. The helper is `server/services/smtp-tls-options.ts`.

## Private or self-signed relays

Do not disable verification. Trust the relay's CA instead:

1. Put the private CA certificate (PEM) on the server.
2. Start the app with `NODE_EXTRA_CA_CERTS=/path/to/private-ca.pem` (or add it to the system trust store).
3. Restart the app and send a test email from the admin SMTP page.

## Retired setting

`SMTP_ALLOW_SELF_SIGNED` is ignored. If it is set, the app logs a warning. It used to turn verification off for the whole process, so SMTP credentials could be sent to an impostor relay.

## Verifying

- Expected: a relay with a trusted certificate sends; a self-signed relay fails with a certificate error unless its CA is trusted.
- Tests: `node --test --experimental-transform-types tests/security/smtp-tls-verification.test.mjs`, `node --test --experimental-transform-types tests/security/smtp-verified-certificates.test.mjs`

## Operator verification

1. Confirm the SMTP host and port, and verify its certificate identity matches the configured hostname.
2. Establish the certificate-chain provenance from the relay operator via a trusted out-of-band channel; do not fetch a CA from the failing connection and blindly trust it.
3. Run the runtime guard in the Tests line above. It checks default and legacy toggles, all transport call sites, a local self-signed server rejection and an explicitly trusted private CA.
4. Test the real tenant SMTP credentials against a staging relay with verified TLS, including the admin **Test SMTP** path. Do not copy SMTP passwords or certificates' private keys into CI logs.
5. Re-run the affected suite after runtime upgrades. Require all CI/build and live-transport verification before closing security issue #3.

This policy does not claim that staging mail delivery, DNS/TLS setup or a live relay has been tested. It only establishes the source-level requirement and a repeatable local TLS handshake contract.
