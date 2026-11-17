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
- Tests: `node --test --experimental-transform-types tests/security/smtp-tls-verification.test.mjs`
