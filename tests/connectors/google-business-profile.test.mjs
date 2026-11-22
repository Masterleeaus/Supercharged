// Google Business Profile lead source (#358). Fake client only; no network, no Google account.
// Run: node --test --experimental-transform-types tests/connectors/google-business-profile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const gbp = await import('../../server/connectors/leads/google-business-profile.ts');
const intake = await import('../../server/connectors/leads/lead-intake.ts');

const LOCATION = 'loc-1';
const SINCE = '2026-11-01T00:00:00Z';
const NOW = new Date('2026-11-18T01:00:00Z');

function fakeClient({ messages = [], reviews = [], failRead = false, failPost = false } = {}) {
  const posts = [];
  return {
    posts,
    async listMessages() {
      if (failRead) throw new Error('timeout after 10s');
      return messages;
    },
    async listReviews() {
      if (failRead) throw new Error('timeout after 10s');
      return reviews;
    },
    async postReply(locationId, target, text) {
      if (failPost) throw new Error('503 from provider');
      posts.push({ locationId, target, text });
      return { id: `reply-${posts.length}` };
    },
  };
}

const enquiry = {
  id: 'm-1',
  senderName: 'Ana Lee',
  senderEmail: 'Ana@Example.COM',
  text: 'Can you quote a gutter clean?',
  createdAt: '2026-11-17T09:00:00Z',
};

test('an enquiry from the profile creates one lead with Google Business Profile attribution', async () => {
  const out = await gbp.pollGoogleBusinessProfile({ locationId: LOCATION, sinceIso: SINCE, receivedAt: NOW }, { client: fakeClient({ messages: [enquiry] }) });
  assert.equal(out.ok, true);
  assert.equal(out.leads.length, 1);
  assert.equal(out.leads[0].source, 'google_business_profile');
  assert.equal(out.leads[0].sourceRef, 'gbp:m-1');
  assert.equal(out.leads[0].email, 'ana@example.com');
  assert.equal(out.rejected, 0);
});

test('the same message seen on two polls gives the same sourceRef, so the caller can stop a second lead', async () => {
  const client = fakeClient({ messages: [enquiry] });
  const a = await gbp.pollGoogleBusinessProfile({ locationId: LOCATION, sinceIso: SINCE, receivedAt: NOW }, { client });
  const b = await gbp.pollGoogleBusinessProfile({ locationId: LOCATION, sinceIso: SINCE, receivedAt: NOW }, { client });
  assert.equal(a.leads[0].sourceRef, b.leads[0].sourceRef);
});

test('the same customer across Google and the web form is matched by email', async () => {
  const gbpOut = await gbp.pollGoogleBusinessProfile({ locationId: LOCATION, sinceIso: SINCE, receivedAt: NOW }, { client: fakeClient({ messages: [enquiry] }) });
  const webLead = intake.normalizeLead('web_form', { name: 'Ana', email: 'ana@example.com', message: 'Hi' }, NOW);
  assert.equal(webLead.ok, true);
  const match = intake.findSameCustomer(gbpOut.leads[0], [{ email: 'ana@example.com', phone: undefined }]);
  assert.ok(match);
});

test('a message with no contact details is rejected, not turned into a lead', async () => {
  const out = await gbp.pollGoogleBusinessProfile(
    { locationId: LOCATION, sinceIso: SINCE, receivedAt: NOW },
    { client: fakeClient({ messages: [{ ...enquiry, id: 'm-2', senderEmail: undefined }] }) },
  );
  assert.equal(out.ok, true);
  assert.equal(out.leads.length, 0);
  assert.equal(out.rejected, 1);
});

test('reviews are read only and are never answered by the poll', async () => {
  const client = fakeClient({ reviews: [{ id: 'r-1', reviewerName: 'Sam', rating: 2, comment: 'Late', createdAt: '2026-11-16T00:00:00Z' }] });
  const out = await gbp.pollGoogleBusinessProfile({ locationId: LOCATION, sinceIso: SINCE, receivedAt: NOW }, { client });
  assert.equal(out.reviews.length, 1);
  assert.equal(client.posts.length, 0);
});

test('a provider timeout on read is reported as an error and creates no leads', async () => {
  const out = await gbp.pollGoogleBusinessProfile({ locationId: LOCATION, sinceIso: SINCE, receivedAt: NOW }, { client: fakeClient({ failRead: true }) });
  assert.deepEqual(out, { ok: false, reason: 'provider_error', message: 'timeout after 10s' });
});

test('a reply without an approval is never posted', async () => {
  const client = fakeClient();
  const out = await gbp.sendApprovedGbpReply({ locationId: LOCATION, target: { kind: 'review', id: 'r-1' }, text: 'Thanks', approval: null }, { client });
  assert.deepEqual(out, { ok: false, reason: 'approval_missing' });
  assert.equal(client.posts.length, 0);
});

test('an approval with no approver name is treated as missing', async () => {
  const client = fakeClient();
  const approval = { approvedBy: ' ', approvedAt: '2026-11-18T01:00:00Z', target: { kind: 'review', id: 'r-1' }, text: 'Thanks' };
  const out = await gbp.sendApprovedGbpReply({ locationId: LOCATION, target: { kind: 'review', id: 'r-1' }, text: 'Thanks', approval }, { client });
  assert.equal(out.reason, 'approval_missing');
  assert.equal(client.posts.length, 0);
});

test('an approval for different text or a different target does not post', async () => {
  const client = fakeClient();
  const approval = { approvedBy: 'owner', approvedAt: '2026-11-18T01:00:00Z', target: { kind: 'review', id: 'r-1' }, text: 'Thanks' };
  const changedText = await gbp.sendApprovedGbpReply({ locationId: LOCATION, target: { kind: 'review', id: 'r-1' }, text: 'Thanks, call us', approval }, { client });
  const otherTarget = await gbp.sendApprovedGbpReply({ locationId: LOCATION, target: { kind: 'review', id: 'r-2' }, text: 'Thanks', approval }, { client });
  assert.equal(changedText.reason, 'approval_mismatch');
  assert.equal(otherTarget.reason, 'approval_mismatch');
  assert.equal(client.posts.length, 0);
});

test('an approved reply is posted exactly once with the approved text', async () => {
  const client = fakeClient();
  const approval = { approvedBy: 'owner', approvedAt: '2026-11-18T01:00:00Z', target: { kind: 'review', id: 'r-1' }, text: 'Thanks' };
  const out = await gbp.sendApprovedGbpReply({ locationId: LOCATION, target: { kind: 'review', id: 'r-1' }, text: 'Thanks', approval }, { client });
  assert.deepEqual(out, { ok: true, replyId: 'reply-1' });
  assert.deepEqual(client.posts, [{ locationId: LOCATION, target: { kind: 'review', id: 'r-1' }, text: 'Thanks' }]);
});

test('a provider failure on reply is reported and not treated as sent', async () => {
  const client = fakeClient({ failPost: true });
  const approval = { approvedBy: 'owner', approvedAt: '2026-11-18T01:00:00Z', target: { kind: 'message', id: 'm-1' }, text: 'Hi' };
  const out = await gbp.sendApprovedGbpReply({ locationId: LOCATION, target: { kind: 'message', id: 'm-1' }, text: 'Hi', approval }, { client });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'provider_error');
  assert.equal(client.posts.length, 0);
});
