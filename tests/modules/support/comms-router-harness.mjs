// Test harness for the comms routers. No Express: a small router that records middleware and
// routes in order, then dispatches a request through them the way Express would.
// Not a *.test.mjs file, so the test runner does not pick it up on its own.
import { buildModeConfig, deskModeMiddleware } from '../../../server/modules/desk-modes/index.ts';

export const MODE_CONFIG = buildModeConfig({
  workforceHosts: 'supercharged.at.work',
  commsHosts: 'syncedat.work',
});

export const COMMS_HOST = 'syncedat.work';
export const WORKFORCE_HOST = 'supercharged.at.work';

export function createFakeRouter() {
  const layers = [];

  function add(method, path, handlers) {
    const keys = [];
    const pattern = path
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    const re = new RegExp(`^${pattern}$`);
    layers.push({ method, re, keys, handlers });
  }

  const router = {
    use(handler) {
      layers.push({ method: null, handler });
    },
    get(path, ...handlers) { add('GET', path, handlers); },
    post(path, ...handlers) { add('POST', path, handlers); },
    patch(path, ...handlers) { add('PATCH', path, handlers); },
  };

  /**
   * Runs the request through the layers in order. A layer that does not match is skipped.
   * `init`: { host, session, body, query, method }. `session` stands in for the auth layer.
   * Returns { status, body }. Unmatched routes get 404.
   */
  async function dispatch(method, path, init = {}) {
    const req = {
      method,
      path,
      params: {},
      query: init.query ?? {},
      headers: init.host === undefined ? {} : { host: init.host },
      body: init.body,
      session: init.session,
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; this.sent = true; },
      sent: false,
      body: undefined,
    };

    const chain = [];
    for (const layer of layers) {
      if (layer.method === null) {
        chain.push({ fn: layer.handler, params: {} });
      } else if (layer.method === method) {
        const m = layer.re.exec(path);
        if (m) {
          const params = {};
          layer.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          for (const fn of layer.handlers) chain.push({ fn, params });
        }
      }
    }

    // Middleware such as deskModeMiddleware calls next() without returning its promise, so
    // track every pending handler and wait for all of them before reading the response.
    const pending = [];
    let idx = 0;
    const next = () => {
      if (res.sent) return undefined;
      const entry = chain[idx++];
      if (!entry) {
        res.status(404).json({ error: 'not_found' });
        return undefined;
      }
      req.params = entry.params;
      const p = Promise.resolve(entry.fn(req, res, next));
      pending.push(p);
      return p;
    };
    next();
    while (pending.length > 0) await Promise.all(pending.splice(0));
    return { status: res.statusCode, body: res.body, req };
  }

  return { router, dispatch };
}

/** A router with the real desk-mode host resolution in front, as it will be in production. */
export function commsStack(buildRouter) {
  const fake = createFakeRouter();
  fake.router.use(deskModeMiddleware(MODE_CONFIG));
  buildRouter(fake.router);
  return fake;
}

/** Scope resolver that reads the session stub set by the test. Mirrors the production auth layer. */
export function sessionScope(req) {
  if (!req.session) return null;
  return { companyId: req.session.companyId, actor: req.session.actor };
}

export const HUMAN_SESSION = { companyId: '11111111-1111-4111-8111-111111111111', role: 'manager', actor: { kind: 'human', id: 'user-1' } };
export const OTHER_COMPANY_SESSION = { companyId: '22222222-2222-4222-8222-222222222222', role: 'manager', actor: { kind: 'human', id: 'user-9' } };
export const AGENT_SESSION = { companyId: '11111111-1111-4111-8111-111111111111', role: 'agent', actor: { kind: 'agent', id: 'agent-7' } };

/**
 * Fake role guard factory, same semantics as middleware/auth requireRole: admin always passes,
 * otherwise the session role must be one of the listed roles. Reads the role from the session stub.
 * With no session it answers 401, standing in for the authenticate layer that runs before
 * requireRole in production.
 */
export function fakeRequireRole(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'Authentication required' });
    const role = req.session.role;
    if (role === 'admin' || (typeof role === 'string' && roles.includes(role))) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

/** Records every call as { method, args } and returns whatever the canned map gives. */
export function recordingService(methods = {}) {
  const calls = [];
  const service = new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string') return undefined;
      return (...args) => {
        calls.push({ method: name, args });
        if (typeof methods[name] === 'function') return methods[name](...args);
        return Promise.resolve(methods[name] ?? { ok: true });
      };
    },
  });
  return { service, calls };
}
