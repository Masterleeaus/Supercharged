import { logger } from '../utils/logger';

const SOURCE = 'SmtpTls';

/**
 * TLS options for every SMTP transport (primary, fallback, test email and admin verification).
 *
 * Certificate verification is always on. The former SMTP_ALLOW_SELF_SIGNED=true switch is retired
 * and ignored: it used to disable verification for the whole process, so SMTP credentials could be
 * sent to an impostor relay. Private or self-signed relays must be trusted through a CA bundle
 * instead (for example NODE_EXTRA_CA_CERTS). See docs/security/smtp-tls-verification.md.
 */
export function smtpTlsOptions(): { rejectUnauthorized: true } {
  if (process.env.SMTP_ALLOW_SELF_SIGNED !== undefined) {
    logger.warn(
      'SMTP_ALLOW_SELF_SIGNED is set but ignored: SMTP certificates are always verified. Trust a private CA with NODE_EXTRA_CA_CERTS.',
      undefined,
      SOURCE,
    );
  }
  return { rejectUnauthorized: true };
}
