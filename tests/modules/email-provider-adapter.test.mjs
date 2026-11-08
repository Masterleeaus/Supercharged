// Email provider adapter tests (node:test). No network, no SMTP. The base sender is a recording stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmailProviderAdapter,
  createEmailServiceSender,
  appendUnsubscribe,
} from '../../server/modules/comms/email-provider-adapter.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const ADDRESS = 'jane.doe@example.com';
const UNSUB = 'https://app.example.com/unsubscribe/token-abc';
const NOW = new Date('2026-11-03T02:00:00Z');

const CONSENTED = {
  handles: { email: ADDRESS },
  consents: [{ channel: 'email', action: 'opt_in', at: '2026-10-01T00:00:00Z', source: 'contact' }],
  timezone: 'UTC',
};

function stubBase(impl = async () => ({ success: true, messageId: 'provider-1' })) {
  const calls = [];
  const base = async (message) => {
    calls.push(message);
    return impl(message);
  };
  return { base, calls };
}

function adapter(overrides = {}) {
  const { base, calls } = stubBase(overrides.impl);
  const suppression = overrides.suppression ?? createSuppressionList();
  const sender = createEmailProviderAdapter({
    companyId: CO,
    suppression,
    loadContact: overrides.loadContact ?? (async () => CONSENTED),
    buildUnsubscribeUrl: overrides.buildUnsubscribeUrl ?? (() => UNSUB),
    base,
    now: () => NOW,
    quietHours: overrides.quietHours,
  });
  return { sender, calls, suppression };
}

function message(overrides = {}) {
  return {
    to: ADDRESS,
    subject: 'Spring offer',
    text: 'Hello there',
    html: undefined,
    headers: { 'Message-ID': '<m1@campaigns.invalid>' },
    ...overrides,
  };
}

test('consented recipient reaches the base sender with the unsubscribe link in text and html', async () => {
  const { sender, calls } = adapter();
  const result = await sender(message());
  assert.deepEqual(result, { success: true, messageId: 'provider-1', auditRecorded: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, ADDRESS);
  assert.ok(calls[0].text.includes(UNSUB));
  assert.ok(calls[0].html.includes(`href="${UNSUB}"`));
  assert.equal(calls[0].headers['List-Unsubscribe'], `<${UNSUB}>`);
  assert.equal(calls[0].headers['Message-ID'], '<m1@campaigns.invalid>');
});

test('an html body gets the link before </body> and keeps its own content', async () => {
  const { sender, calls } = adapter();
  await sender(message({ html: '<html><body><p>Offer</p></body></html>' }));
  assert.match(
    calls[0].html,
    /^<html><body><p>Offer<\/p><p style="[^"]*">To stop these emails, <a href="[^"]+">unsubscribe<\/a>\.<\/p><\/body><\/html>$/,
  );
});

test('suppressed address is refused and the base sender is never called', async () => {
  const suppression = createSuppressionList();
  suppression.suppress(CO, { channel: 'email', address: ADDRESS, reason: 'bounce_hard' });
  const { sender, calls } = adapter({ suppression });
  const result = await sender(message());
  assert.deepEqual(result, { success: false, error: 'suppressed' });
  assert.equal(calls.length, 0);
});

test('suppression is company-scoped: another company list does not block this one', async () => {
  const suppression = createSuppressionList();
  suppression.suppress('22222222-2222-4222-8222-222222222222', {
    channel: 'email',
    address: ADDRESS,
    reason: 'unsubscribed',
  });
  const { sender, calls } = adapter({ suppression });
  const result = await sender(message());
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
});

test('contact with no consent records is refused', async () => {
  const { sender, calls } = adapter({ loadContact: async () => ({ handles: { email: ADDRESS } }) });
  assert.deepEqual(await sender(message()), { success: false, error: 'consent_no_consent' });
  assert.equal(calls.length, 0);
});

test('contact who opted out of email is refused', async () => {
  const contact = {
    handles: { email: ADDRESS },
    consents: [
      { channel: 'email', action: 'opt_in', at: '2026-10-01T00:00:00Z', source: 'contact' },
      { channel: 'email', action: 'opt_out', at: '2026-10-20T00:00:00Z', source: 'contact' },
    ],
  };
  const { sender, calls } = adapter({ loadContact: async () => contact });
  assert.deepEqual(await sender(message()), { success: false, error: 'consent_opted_out' });
  assert.equal(calls.length, 0);
});

test('missing contact fails closed', async () => {
  const { sender, calls } = adapter({ loadContact: async () => null });
  assert.deepEqual(await sender(message()), { success: false, error: 'consent_invalid_contact' });
  assert.equal(calls.length, 0);
});

test('quiet hours block the send when configured', async () => {
  const { sender, calls } = adapter({
    quietHours: { startHour: 1, endHour: 6 },
    loadContact: async () => ({ ...CONSENTED, timezone: 'UTC' }),
  });
  assert.deepEqual(await sender(message()), { success: false, error: 'consent_quiet_hours' });
  assert.equal(calls.length, 0);
});

test('invalid recipient address is refused before any lookup', async () => {
  let looked = false;
  const { sender, calls } = adapter({
    loadContact: async () => {
      looked = true;
      return CONSENTED;
    },
  });
  assert.deepEqual(await sender(message({ to: 'not-an-address' })), { success: false, error: 'invalid_address' });
  assert.equal(looked, false);
  assert.equal(calls.length, 0);
});

test('unsafe or missing unsubscribe URL blocks the send', async () => {
  const bad = ['javascript:alert(1)', 'https://x.example/"><script>', '', 'not a url'];
  for (const url of bad) {
    const { sender, calls } = adapter({ buildUnsubscribeUrl: () => url });
    assert.deepEqual(await sender(message()), { success: false, error: 'unsubscribe_unavailable' });
    assert.equal(calls.length, 0);
  }
});

test('a throwing contact lookup blocks the send with a fixed code and no address', async () => {
  const { sender, calls } = adapter({
    loadContact: async () => {
      throw new Error(`db down for ${ADDRESS}`);
    },
  });
  const result = await sender(message());
  assert.deepEqual(result, { success: false, error: 'guard_error' });
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(result).includes(ADDRESS));
});

test('the base sender result is returned unchanged, including failures', async () => {
  const { sender } = adapter({
    impl: async () => ({ success: false, error: 'SMTP refused' }),
  });
  assert.deepEqual(await sender(message()), { success: false, error: 'SMTP refused', auditRecorded: false });
});

test('appendUnsubscribe builds an html body when only text is given and escapes it', () => {
  const out = appendUnsubscribe(
    { to: ADDRESS, subject: 's', text: '<b>hi</b>\nline two', headers: {} },
    UNSUB,
  );
  assert.ok(out.html.startsWith('<div>&lt;b&gt;hi&lt;/b&gt;<br>line two</div>'));
  assert.ok(out.text.startsWith('<b>hi</b>\nline two\n\n'));
});

test('createEmailServiceSender is exported as a factory and is not called at import time', () => {
  assert.equal(typeof createEmailServiceSender, 'function');
});
