import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMetricsMiddleware,
  createMetricsAccessGuard,
  routeLabel,
  UNMATCHED_ROUTE,
} from '../../server/middleware/metrics.ts';
import {
  createMetricsRecorder,
  createNoopRecorder,
  resetMetricsWarningForTests,
  HTTP_REQUESTS_METRIC,
} from '../../server/services/metrics.ts';

function fakeRes() {
  const listeners = {};
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    on(event, cb) { (listeners[event] ||= []).push(cb); return this; },
    emit(event) { (listeners[event] || []).forEach((cb) => cb()); },
  };
}

function fakeSink() {
  const samples = [];
  return { samples, observeHttpRequest(s) { samples.push(s); } };
}

function runRequest({ sink, req, status = 200, finish = true, closeOnly = false }) {
  const mw = createMetricsMiddleware(sink);
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  if (closeOnly) {
    res.emit('close');
  } else {
    res.statusCode = status;
    if (finish) res.emit('finish');
    res.emit('close');
  }
  return res;
}

test('route pattern is used as the label, not the raw URL', () => {
  const sink = fakeSink();
  for (const id of ['123', '456', 'abc?token=secret']) {
    runRequest({
      sink,
      status: 200,
      req: {
        method: 'GET',
        baseUrl: '',
        originalUrl: `/api/users/${id}`,
        route: { path: '/api/users/:id' },
      },
    });
  }
  assert.equal(sink.samples.length, 3);
  for (const s of sink.samples) {
    assert.equal(s.route, '/api/users/:id');
    assert.equal(s.method, 'GET');
    assert.equal(s.statusClass, '2xx');
    assert.ok(s.durationSeconds >= 0);
    assert.ok(!s.route.includes('secret'));
    assert.ok(!/\d{3}/.test(s.route));
  }
});

test('baseUrl of a mounted router is prefixed onto the route pattern', () => {
  assert.equal(routeLabel({ baseUrl: '/api', route: { path: '/items/:id' } }), '/api/items/:id');
});

test('unmatched requests collapse to a fixed label, never the raw URL', () => {
  const sink = fakeSink();
  runRequest({
    sink,
    status: 404,
    req: { method: 'GET', baseUrl: '', originalUrl: '/random/path/999', route: undefined },
  });
  assert.equal(sink.samples[0].route, UNMATCHED_ROUTE);
  assert.equal(sink.samples[0].statusClass, '4xx');
});

test('unknown HTTP methods are normalised to OTHER to bound cardinality', () => {
  const sink = fakeSink();
  runRequest({ sink, req: { method: 'BREW', baseUrl: '', route: { path: '/x' } } });
  runRequest({ sink, status: 201, req: { method: 'post', baseUrl: '', route: { path: '/x' } } });
  assert.equal(sink.samples[0].method, 'OTHER');
  assert.equal(sink.samples[1].method, 'POST');
  assert.equal(sink.samples[1].statusClass, '2xx');
});

test('a client disconnect before finish is recorded as aborted, once', () => {
  const sink = fakeSink();
  runRequest({ sink, closeOnly: true, req: { method: 'GET', baseUrl: '', route: { path: '/slow' } } });
  assert.equal(sink.samples.length, 1);
  assert.equal(sink.samples[0].statusClass, 'aborted');
});

test('a throwing sink never breaks the response path', () => {
  const mw = createMetricsMiddleware({ observeHttpRequest() { throw new Error('boom'); } });
  const res = fakeRes();
  let nextCalled = false;
  mw({ method: 'GET', baseUrl: '', route: { path: '/a' } }, res, () => { nextCalled = true; });
  assert.doesNotThrow(() => res.emit('finish'));
  assert.equal(nextCalled, true);
});

test('no-op fallback when prom-client cannot be loaded', async () => {
  resetMetricsWarningForTests();
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const broken = () => { throw new Error("Cannot find module 'prom-client'"); };

  const a = createMetricsRecorder({ loadPromClient: broken, logger });
  const b = createMetricsRecorder({ loadPromClient: broken, logger });

  assert.equal(a.enabled, false);
  assert.equal(b.enabled, false);
  assert.doesNotThrow(() => a.counter('x_total', 'x', ['k']).inc({ k: 'v' }));
  assert.doesNotThrow(() => a.histogram('y', 'y', ['k']).observe({ k: 'v' }, 0.2));
  assert.doesNotThrow(() => a.observeHttpRequest({ method: 'GET', route: '/', statusClass: '2xx', durationSeconds: 0.1 }));
  assert.equal(await a.render(), '');
  assert.equal(warnings.length, 1, 'warns exactly once across recorders');
  assert.match(warnings[0], /prom-client/);
});

test('createNoopRecorder is inert and exposes a Prometheus content type', async () => {
  const r = createNoopRecorder();
  assert.equal(r.enabled, false);
  assert.match(r.contentType(), /^text\/plain/);
  assert.equal(await r.render(), '');
});

test('prom-client path wires HTTP metrics and reuses collectors by name', () => {
  resetMetricsWarningForTests();
  const created = [];
  const incs = [];
  const observes = [];
  class FakeRegistry { constructor() { this.contentType = 'text/fake'; } async metrics() { return '# fake\n'; } }
  class FakeCounter {
    constructor(cfg) { created.push({ type: 'counter', ...cfg }); this.cfg = cfg; }
    inc(labels, value) { incs.push({ name: this.cfg.name, labels, value }); }
  }
  class FakeHistogram {
    constructor(cfg) { created.push({ type: 'histogram', ...cfg }); this.cfg = cfg; }
    observe(labels, value) { observes.push({ name: this.cfg.name, labels, value }); }
  }
  const recorder = createMetricsRecorder({
    loadPromClient: () => ({ Registry: FakeRegistry, Counter: FakeCounter, Histogram: FakeHistogram }),
    logger: { warn() {} },
  });

  assert.equal(recorder.enabled, true);
  recorder.observeHttpRequest({ method: 'GET', route: '/api/users/:id', statusClass: '2xx', durationSeconds: 0.042 });

  const c1 = recorder.counter('desk_jobs_total', 'jobs', ['queue']);
  const c2 = recorder.counter('desk_jobs_total', 'jobs', ['queue']);
  assert.equal(c1, c2);
  c1.inc({ queue: 'default' });

  const counterCreations = created.filter((c) => c.name === 'desk_jobs_total');
  assert.equal(counterCreations.length, 1, 'collector constructed once per name');

  const httpInc = incs.find((i) => i.name === HTTP_REQUESTS_METRIC);
  assert.deepEqual(httpInc.labels, { method: 'GET', route: '/api/users/:id', status_class: '2xx' });
  assert.equal(observes[0].value, 0.042);
  assert.equal(recorder.contentType(), 'text/fake');
});

test('guard returns 404 when neither a metrics token nor admin auth is configured', () => {
  const guard = createMetricsAccessGuard({});
  const res = fakeRes();
  let nextCalled = false;
  guard({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 404);
  assert.equal(nextCalled, false);
});

test('/metrics without a token is refused when METRICS_TOKEN is configured', () => {
  const guard = createMetricsAccessGuard({ metricsToken: 'scrape-secret-value' });
  const res = fakeRes();
  let nextCalled = false;
  guard({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('a wrong bearer token is refused, a correct one is admitted', () => {
  const guard = createMetricsAccessGuard({ metricsToken: 'scrape-secret-value' });

  const bad = fakeRes();
  let badNext = false;
  guard({ headers: { authorization: 'Bearer nope' } }, bad, () => { badNext = true; });
  assert.equal(bad.statusCode, 401);
  assert.equal(badNext, false);

  const good = fakeRes();
  let goodNext = false;
  guard({ headers: { authorization: 'Bearer scrape-secret-value' } }, good, () => { goodNext = true; });
  assert.equal(goodNext, true);
});

test('admin auth is used when no valid metrics token is presented', () => {
  let adminCalls = 0;
  const guard = createMetricsAccessGuard({
    metricsToken: 'scrape-secret-value',
    adminAuth: (_req, _res, next) => { adminCalls += 1; next(); },
  });
  let nextCalled = false;
  guard({ headers: {} }, fakeRes(), () => { nextCalled = true; });
  assert.equal(adminCalls, 1);
  assert.equal(nextCalled, true);
});
