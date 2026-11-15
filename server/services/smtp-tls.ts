/**
 * SMTP transport TLS policy.
 *
 * Certificate validation is mandatory for every SMTP connection, including
 * admin test sends and legacy provider settings. The former process-wide
 * SMTP_ALLOW_SELF_SIGNED switch is intentionally ignored: it disabled
 * certificate identity verification for all tenant mail.
 *
 * Deployments using a private certificate authority must install the CA into
 * the host trust store or use Node's NODE_EXTRA_CA_CERTS with a reviewed PEM
 * file readable by the server. Never accept an arbitrary SMTP certificate.
 */
export interface SmtpTlsOptions {
  readonly rejectUnauthorized: true;
}

export function smtpTlsOptions(): SmtpTlsOptions {
  return { rejectUnauthorized: true };
}
