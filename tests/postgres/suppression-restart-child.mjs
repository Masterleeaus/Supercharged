// Child process for the restart test. It starts with an empty memory and reads only what is in PostgreSQL.
// Usage: node --experimental-transform-types suppression-restart-child.mjs '<json input>'
// Prints one JSON line on stdout. It never prints the connection string.
import pg from 'pg';
import { createDurableSuppressionList } from '../../server/modules/comms/suppression.ts';
import { createPostgresSuppressionPersistence } from '../../server/modules/comms/suppression-postgres.ts';
import { createEmailProviderAdapter } from '../../server/modules/comms/email-provider-adapter.ts';

const input = JSON.parse(process.argv[2] ?? '{}');
const pool = new pg.Pool({ connectionString: process.env.SUPPRESSION_PG_INTEGRATION_URL, max: 2 });

try {
  const list = createDurableSuppressionList({ persistence: createPostgresSuppressionPersistence({ pool }) });
  await list.warm(input.companyId);
  await list.warm(input.otherCompanyId);
  const out = {};

  if (input.mode === 'checks') {
    out.adaSuppressed = list.isSuppressed(input.companyId, { address: input.ada, channel: 'email' });
    out.adaReason = list.reasonFor(input.companyId, { address: input.ada, channel: 'email' });
    out.otherSuppressed = list.isSuppressed(input.otherCompanyId, { address: input.ada, channel: 'email' });
    out.carolSuppressed = list.isSuppressed(input.companyId, { address: input.carol, channel: 'email' });
    // Bob has two soft bounces stored by the parent. This is the third, so it should reach the threshold.
    out.bobThird = list.suppress(input.companyId, { address: input.bob, channel: 'email', reason: 'bounce_soft' });
    await list.flush();
  } else if (input.mode === 'send') {
    let baseCalls = 0;
    const sender = createEmailProviderAdapter({
      companyId: input.companyId,
      suppression: list,
      loadContact: async () => ({
        handles: { email: input.sendTo },
        consents: [{ channel: 'email', action: 'opt_in', at: '2026-10-01T00:00:00Z', source: 'contact' }],
        timezone: 'UTC',
      }),
      buildUnsubscribeUrl: () => 'https://app.example.com/unsubscribe/token-abc',
      base: async () => {
        baseCalls += 1;
        return { success: true, messageId: 'provider-1' };
      },
      now: () => new Date('2026-11-03T02:00:00Z'),
    });
    const result = await sender({
      to: input.sendTo,
      subject: 'Spring offer',
      text: 'Hello there',
      headers: { 'Message-ID': '<m1@campaigns.invalid>' },
    });
    out.success = result.success;
    out.error = result.error ?? null;
    out.baseCalls = baseCalls;
  }

  console.log(JSON.stringify(out));
} finally {
  await pool.end();
}
