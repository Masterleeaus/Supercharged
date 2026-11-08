/*
 * Adapts the email send transport to the campaign port. The transport reports failures as
 * { ok: false, reason, detail }. The port only knows success or a thrown error, so a failure
 * becomes an Error whose message is the reason code. The detail is left out on purpose: it can
 * carry provider text, and the error must never carry a recipient address.
 */
import type { SendTransport } from '../campaigns/ports.ts';
import type { SendJob } from '../campaigns/types.ts';
import type { EmailSendTransport } from './email-send-transport.ts';

export interface EmailCampaignAdapterOptions {
  /**
   * Called after a successful send with the Message-ID the send carried (the externalId). Use it
   * to store the id on the thread so that replies can be matched back (see thread-match.ts).
   * A failure here is swallowed: the message has already left, and throwing would make the
   * campaign retry and send it twice.
   */
  onSent?: (companyId: string, job: SendJob, messageId: string) => Promise<void> | void;
}

export function adaptEmailTransportToPort(
  transport: EmailSendTransport,
  options: EmailCampaignAdapterOptions = {},
): SendTransport {
  return {
    async send(companyId, job, content) {
      const result = await transport.send(companyId, job, content);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      if (options.onSent) {
        try {
          await options.onSent(companyId, job, result.externalId);
        } catch {
          // Recording is best-effort. The send already succeeded.
        }
      }
      return { externalId: result.externalId };
    },
  };
}
