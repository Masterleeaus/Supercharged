// Inbound email route tests (node:test). Real Express app on an ephemeral localhost port.
// The verifier and the store are fakes. No network beyond 127.0.0.1, no database.
// Run: node --test --experimental-transform-types tests/modules/email-inbound-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Silence logging: the runner's IPC breaks if a test file writes to stdout.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const { createEmailInboundRouter, EMAIL_INBOUND_DEFAULT_PATH } = await import(
  '../../server/modules/comms/email-inbound-route.ts'
);

const CO = '11111111-1111-4111-8111-111111111111';
const CO_OTHER = '22222222-2222-4222-8222-222222222222';
const PATH = EMAIL_INBOUND_DEFAULT_PATH;
const DATE = '2026-11-03T10:00:00Z';
const DAY = 24 * 60 * 60 * 1000;
const GOOD_SIG = 'fake-signature-ok';

function passThroughGuard(_req, _res, next) {
  next();
}

/** In-memory store fake. Records every write. Threads are scoped by company. */
function fakeStore(seed = []) {
  const threads = seed.map((t) => ({ ...t }));
  const messageIds = new Set();
  const writes = [];
  let seq = 0;
  for (const t of threads) for (const id of t.messageIds) messageIds.add(`${t.companyId}|${id}`);
  return {
    threads,
    writes,
    async listEmailThreads(companyId) {
      return threads
        .filter((t) => t.companyId === companyId && t.channel === 'email')
        .map((t) => ({ ...t, messageIds: [...t.messageIds] }));
    },
    async hasMessage(companyId, messageId) {
      return messageIds.has(`${companyId}|${messageId}`);
    },
    async attachMessage(companyId, threadId, inbound) {
      writes.push({ op: 'attach', companyId, threadId, messageId: inbound.messageId });
      const t = threads.find((x) => x.id === threadId && x.companyId === companyId);
      if (!t) throw new Error('no such thread');
      t.messageIds.push(inbound.messageId);
      t.lastMessageAt = new Date(inbound.receivedAt);
      messageIds.add(`${companyId}|${inbound.messageId}`);
    },
    async createThread(companyId, inbound) {
      seq += 1;
      const id = `new-${seq}`;
      writes.push({ op: 'create', companyId, threadId: id, messageId: inbound.messageId });
      threads.push({
        id,
        companyId,
        channel: 'email',
        participantAddress: inbound.fromAddress,
        providerThreadId: null,
        messageIds: [inbound.messageId],
        lastMessageAt: new Date(inbound.receivedAt),
      });
      messageIds.add(`${companyId}|${inbound.messageId}`);
      return id;
    },
  };
}

/** Verifier fake: accepts exactly one signature value. Records what it was given. */
function fakeVerifier(expected = GOOD_SIG) {
  const seen = [];
  const fn = async ({ headers, rawBody }) => {
    seen.push({ signature: headers['x-fake-signature'], body: rawBody.toString('utf8') });
    return headers['x-fake-signature'] === expected;
  };
  return { fn, seen };
}

function message(overrides = {}) {
  return {
    from: 'Pat@Example.com',
    to: 'desk@company.test',
    subject: 'Re: Quote',
    text: 'Yes please.',
    messageId: '<in-1@example.com>',
    date: DATE,
    ...overrides,
  };
}

async function startServer(router) {
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${PATH}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function post(url, body, { signature = GOOD_SIG, rawText, headers = {} } = {}) {
  const hdrs = { 'content-type': 'application/json', ...headers };
  if (signature !== null) hdrs['x-fake-signature'] = signature;
  const res = await fetch(url, {
    method: 'POST',
    headers: hdrs,
    body: rawText !== undefined ? rawText : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function build(overrides = {}) {
  const store = overrides.store ?? fakeStore();
  const verifier = overrides.verifier ?? fakeVerifier();
  const router = createEmailInboundRouter(
    {
      companyId: overrides.companyId ?? CO,
      verifySignature: verifier.fn,
      store,
      path: PATH,
      ...(overrides.deps ?? {}),
    },
    { modeGuard: overrides.modeGuard ?? passThroughGuard },
  );
  return { store, verifier, router };
}

// ---- Signature: fail closed -------------------------------------------------

test('an unsigned request is refused with 401 and nothing is stored', async () => {
  const { store, router } = build();
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message(), { signature: null });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized' });
    assert.equal(store.writes.length, 0);
  } finally {
    await srv.close();
  }
});

test('a wrong signature is refused with 401 and nothing is stored', async () => {
  const { store, router } = build();
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message(), { signature: 'forged' });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized' });
    assert.equal(store.writes.length, 0);
  } finally {
    await srv.close();
  }
});

test('a verifier that throws fails closed with 401', async () => {
  const store = fakeStore();
  const router = createEmailInboundRouter(
    {
      companyId: CO,
      verifySignature: () => {
        throw new Error('secret store unreachable');
      },
      store,
      path: PATH,
    },
    { modeGuard: passThroughGuard },
  );
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message());
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized' });
    assert.equal(store.writes.length, 0);
  } finally {
    await srv.close();
  }
});

test('a verifier that returns a truthy non-boolean is not accepted', async () => {
  const store = fakeStore();
  const router = createEmailInboundRouter(
    { companyId: CO, verifySignature: () => 'yes', store, path: PATH },
    { modeGuard: passThroughGuard },
  );
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message());
    assert.equal(res.status, 401);
    assert.equal(store.writes.length, 0);
  } finally {
    await srv.close();
  }
});

test('the verifier receives the exact raw bytes that were sent', async () => {
  const { router, verifier } = build();
  const srv = await startServer(router);
  try {
    const raw = '{"from":"pat@example.com",  "messageId":"<raw@x>","date":"2026-11-03T10:00:00Z"}';
    await post(srv.url, null, { rawText: raw });
    assert.equal(verifier.seen.length, 1);
    assert.equal(verifier.seen[0].body, raw);
  } finally {
    await srv.close();
  }
});

// ---- Company comes from configuration only ----------------------------------

test('a companyId in the body is ignored; the configured company is used', async () => {
  const { store, router } = build({ companyId: CO });
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, { ...message(), companyId: CO_OTHER, company_id: CO_OTHER });
    assert.equal(res.status, 200);
    assert.equal(store.writes.length, 1);
    assert.equal(store.writes[0].companyId, CO);
  } finally {
    await srv.close();
  }
});

test('a companyId in the query or path does not change the company', async () => {
  const { store, router } = build({ companyId: CO });
  const srv = await startServer(router);
  try {
    const res = await fetch(`${srv.url}?companyId=${CO_OTHER}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fake-signature': GOOD_SIG },
      body: JSON.stringify(message()),
    });
    assert.equal(res.status, 200);
    assert.equal(store.writes[0].companyId, CO);
  } finally {
    await srv.close();
  }
});

test('a router cannot be built without a company', () => {
  for (const companyId of ['', '   ', undefined, null]) {
    assert.throws(
      () =>
        createEmailInboundRouter(
          { companyId, verifySignature: fakeVerifier().fn, store: fakeStore(), path: PATH },
          { modeGuard: passThroughGuard },
        ),
      /companyId is required/,
    );
  }
});

// ---- Threading -----------------------------------------------------------------

test('a reply whose In-Reply-To matches a stored outbound Message-ID joins that thread', async () => {
  const store = fakeStore([
    {
      id: 'campaign-thread',
      companyId: CO,
      channel: 'email',
      participantAddress: 'someone-else@example.com',
      providerThreadId: null,
      messageIds: ['<ext-42@campaigns.invalid>'],
      lastMessageAt: new Date(Date.parse(DATE) - 60_000),
    },
  ]);
  const { router } = build({ store });
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message({ inReplyTo: '<ext-42@campaigns.invalid>' }));
    assert.equal(res.status, 200);
    assert.equal(res.json.outcome, 'attached');
    assert.deepEqual(store.writes, [
      { op: 'attach', companyId: CO, threadId: 'campaign-thread', messageId: '<in-1@example.com>' },
    ]);
  } finally {
    await srv.close();
  }
});

test('References are used when In-Reply-To is absent, newest ancestor first', async () => {
  const store = fakeStore([
    {
      id: 'older',
      companyId: CO,
      channel: 'email',
      participantAddress: 'x@example.com',
      messageIds: ['<root@x>'],
      lastMessageAt: new Date(Date.parse(DATE) - DAY),
    },
    {
      id: 'newer',
      companyId: CO,
      channel: 'email',
      participantAddress: 'y@example.com',
      messageIds: ['<mid@x>'],
      lastMessageAt: new Date(Date.parse(DATE) - DAY),
    },
  ]);
  const { router } = build({ store });
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message({ references: '<root@x> <mid@x>' }));
    assert.equal(res.status, 200);
    assert.equal(store.writes[0].threadId, 'newer');
  } finally {
    await srv.close();
  }
});

test('a bare stored id matches a bracketed reply header', async () => {
  const store = fakeStore([
    {
      id: 'bare',
      companyId: CO,
      channel: 'email',
      participantAddress: 'other@example.com',
      messageIds: ['ext-7@campaigns.invalid'],
      lastMessageAt: new Date(Date.parse(DATE) - DAY),
    },
  ]);
  const { router } = build({ store });
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message({ inReplyTo: '<ext-7@campaigns.invalid>' }));
    assert.equal(res.json.outcome, 'attached');
    assert.equal(store.writes[0].threadId, 'bare');
  } finally {
    await srv.close();
  }
});

test('unmatched mail is recorded as a new thread, not dropped', async () => {
  const store = fakeStore([
    {
      id: 'other',
      companyId: CO,
      channel: 'email',
      participantAddress: 'someone@else.com',
      messageIds: ['<z@x>'],
      lastMessageAt: new Date(Date.parse(DATE) - 90 * DAY),
    },
  ]);
  const { router } = build({ store });
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message({ inReplyTo: '<unknown@x>' }));
    assert.equal(res.status, 200);
    assert.equal(res.json.outcome, 'created');
    assert.equal(store.writes.length, 1);
    assert.equal(store.writes[0].op, 'create');
    assert.equal(store.threads.length, 2);
    const created = store.threads.find((t) => t.id === store.writes[0].threadId);
    assert.deepEqual(created.messageIds, ['<in-1@example.com>']);
    assert.equal(created.participantAddress, 'pat@example.com');
  } finally {
    await srv.close();
  }
});

test('a known sender within 30 days joins the recent thread when no id matches', async () => {
  const store = fakeStore([
    {
      id: 'recent',
      companyId: CO,
      channel: 'email',
      participantAddress: 'pat@example.com',
      messageIds: ['<old@x>'],
      lastMessageAt: new Date(Date.parse(DATE) - 2 * DAY),
    },
  ]);
  const { router } = build({ store });
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message());
    assert.equal(res.json.outcome, 'attached');
    assert.equal(store.writes[0].threadId, 'recent');
  } finally {
    await srv.close();
  }
});

test('a thread in another company is never matched', async () => {
  const store = fakeStore([
    {
      id: 'foreign',
      companyId: CO_OTHER,
      channel: 'email',
      participantAddress: 'pat@example.com',
      messageIds: ['<in-link@x>'],
      lastMessageAt: new Date(Date.parse(DATE) - DAY),
    },
  ]);
  const { router } = build({ store });
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message({ inReplyTo: '<in-link@x>' }));
    assert.equal(res.json.outcome, 'created');
    assert.equal(store.writes[0].companyId, CO);
    assert.notEqual(store.writes[0].threadId, 'foreign');
  } finally {
    await srv.close();
  }
});

// ---- Dedupe and payload checks ------------------------------------------------

test('a Message-ID already stored is acknowledged and not stored twice', async () => {
  const store = fakeStore();
  const { router } = build({ store });
  const srv = await startServer(router);
  try {
    const first = await post(srv.url, message());
    const second = await post(srv.url, message());
    assert.equal(first.json.outcome, 'created');
    assert.equal(second.status, 200);
    assert.equal(second.json.outcome, 'duplicate');
    assert.equal(store.writes.length, 1);
  } finally {
    await srv.close();
  }
});

test('invalid JSON and non-object bodies get 400 with a generic body', async () => {
  const { store, router } = build();
  const srv = await startServer(router);
  try {
    const broken = await post(srv.url, null, { rawText: '{not json' });
    assert.equal(broken.status, 400);
    assert.deepEqual(broken.json, { error: 'invalid_payload' });

    const array = await post(srv.url, [message()]);
    assert.equal(array.status, 400);
    assert.deepEqual(array.json, { error: 'invalid_payload' });

    assert.equal(store.writes.length, 0);
  } finally {
    await srv.close();
  }
});

test('a message without a Message-ID is refused with 400', async () => {
  const { store, router } = build();
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message({ messageId: '' }));
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid_payload' });
    assert.equal(store.writes.length, 0);
  } finally {
    await srv.close();
  }
});

test('a store failure returns a fixed 500 body with no detail', async () => {
  const store = fakeStore();
  store.createThread = async () => {
    throw new Error('connection to db-prod-7 refused for pat@example.com');
  };
  const { router } = build({ store });
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message());
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { error: 'internal_error' });
    assert.ok(!JSON.stringify(res.json).includes('db-prod'));
  } finally {
    await srv.close();
  }
});

async function serveAfter(parser, router) {
  const app = express();
  app.use(parser);
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}${PATH}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('with an earlier JSON parser that keeps rawBody (as the app does), the signature covers those bytes', async () => {
  const store = fakeStore();
  const verifier = fakeVerifier();
  const router = createEmailInboundRouter(
    { companyId: CO, verifySignature: verifier.fn, store, path: PATH },
    { modeGuard: passThroughGuard },
  );
  const parser = express.json({
    limit: '50mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  });
  const srv = await serveAfter(parser, router);
  try {
    const raw = JSON.stringify(message({ messageId: '<kept@x>' }));
    const res = await post(srv.url, null, { rawText: raw });
    assert.equal(res.status, 200);
    assert.equal(res.json.outcome, 'created');
    assert.equal(verifier.seen[0].body, raw);
    assert.equal(store.writes[0].messageId, '<kept@x>');
  } finally {
    await srv.close();
  }
});

test('an earlier parser that drops the raw bytes makes the route refuse rather than verify a parsed body', async () => {
  const store = fakeStore();
  const verifier = fakeVerifier();
  const router = createEmailInboundRouter(
    { companyId: CO, verifySignature: verifier.fn, store, path: PATH },
    { modeGuard: passThroughGuard },
  );
  const srv = await serveAfter(express.json(), router);
  try {
    const res = await post(srv.url, message());
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid_request' });
    assert.equal(verifier.seen.length, 0);
    assert.equal(store.writes.length, 0);
  } finally {
    await srv.close();
  }
});

test('the mode guard runs before signature checks', async () => {
  const calls = [];
  const guard = (_req, res) => {
    calls.push('guard');
    res.status(403).json({ error: 'forbidden' });
  };
  const verifier = fakeVerifier();
  const { store, router } = build({ verifier, modeGuard: guard });
  const srv = await startServer(router);
  try {
    const res = await post(srv.url, message());
    assert.equal(res.status, 403);
    assert.deepEqual(calls, ['guard']);
    assert.equal(verifier.seen.length, 0);
    assert.equal(store.writes.length, 0);
  } finally {
    await srv.close();
  }
});

// ---- Construction -------------------------------------------------------------

test('construction throws when the verifier, store, or mode guard is missing', () => {
  const store = fakeStore();
  assert.throws(
    () => createEmailInboundRouter({ companyId: CO, store, path: PATH }, { modeGuard: passThroughGuard }),
    /verifySignature is required/,
  );
  assert.throws(
    () => createEmailInboundRouter({ companyId: CO, verifySignature: fakeVerifier().fn, path: PATH }, { modeGuard: passThroughGuard }),
    /store is incomplete/,
  );
  assert.throws(
    () => createEmailInboundRouter({ companyId: CO, verifySignature: fakeVerifier().fn, store, path: PATH }, {}),
    /modeGuard is required/,
  );
});
