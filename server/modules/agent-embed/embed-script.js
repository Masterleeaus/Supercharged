/*
 * Agent embed loader. One script tag per agent on a host page:
 *
 *   <script src="https://PLATFORM/embed/embed-script.js"
 *           data-agent-id="AGENT_ID"
 *           data-color="#2563eb"          (optional, #RRGGBB)
 *           data-position="right"         (optional: left | right)
 *           data-title="Ask us"           (optional, plain text)
 *           data-width="380"              (optional, px, clamped 280-720)
 *           data-height="600"             (optional, px, clamped 320-900)
 *           async></script>
 *
 * What the script does:
 *   1. Reads data-* attributes. The platform origin comes from the script's own src.
 *   2. GET  PLATFORM/embed/AGENT_ID/config   (the server checks the host origin).
 *   3. Draws a launcher inside a shadow root. Only textContent is used for server data.
 *   4. On first open, creates an iframe at PLATFORM/embed/AGENT_ID/frame.
 *   5. POST PLATFORM/embed/AGENT_ID/session  (the server mints a short-lived token bound
 *      to this host origin). The token is passed to the iframe with postMessage after
 *      the iframe says it is ready. It is never placed in a URL or attribute.
 *
 * Security properties:
 *   - Contains no provider credential and calls no model provider. Every request goes to
 *     the platform origin, and only the /embed/ routes.
 *   - Messages are accepted only from the platform origin and from this iframe's window.
 *   - Fails closed. If config or session cannot be loaded, nothing is rendered.
 */
(function () {
  'use strict';

  var AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  var DEFAULT_COLOR = '#2563eb';
  var REFRESH_LEAD_MS = 60 * 1000;
  var MSG_SOURCE = 'agent-embed';

  var script = document.currentScript || document.querySelector('script[data-agent-id][src*="embed-script.js"]');
  if (!script) return;

  var agentId = script.getAttribute('data-agent-id') || '';
  if (!AGENT_ID_RE.test(agentId)) {
    warn('data-agent-id is missing or malformed.');
    return;
  }

  var base;
  try {
    base = new URL(script.src).origin;
  } catch (e) {
    warn('script src is not a valid URL.');
    return;
  }
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
    warn('platform origin must be https.');
    return;
  }

  var agentPath = '/embed/' + encodeURIComponent(agentId);
  var overrides = {
    color: script.getAttribute('data-color'),
    position: script.getAttribute('data-position'),
    title: script.getAttribute('data-title'),
    width: clamp(script.getAttribute('data-width'), 280, 720, 380),
    height: clamp(script.getAttribute('data-height'), 320, 900, 600)
  };

  var state = {
    config: null,
    token: null,
    tokenExpiresAt: 0,
    frameUrl: null,
    refreshTimer: null,
    iframe: null,
    open: false,
    host: null,
    panel: null,
    launcher: null
  };

  function warn(message) {
    try {
      console.warn('[agent-embed] ' + message);
    } catch (e) { /* console unavailable */ }
  }

  function clamp(raw, min, max, fallback) {
    var n = parseInt(raw, 10);
    if (isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function request(path, method, body) {
    var init = {
      method: method,
      credentials: 'omit',
      mode: 'cors',
      headers: { Accept: 'application/json' }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(base + path, init).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var error = new Error('HTTP ' + response.status);
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function resolveColor() {
    if (overrides.color && COLOR_RE.test(overrides.color)) return overrides.color;
    var fromServer = state.config && state.config.theme && state.config.theme.primaryColor;
    return typeof fromServer === 'string' && COLOR_RE.test(fromServer) ? fromServer : DEFAULT_COLOR;
  }

  function resolvePosition() {
    var p = overrides.position;
    if (p === 'left' || p === 'right') return p;
    var fromServer = state.config && state.config.theme && state.config.theme.position;
    return fromServer === 'bottom-left' ? 'left' : 'right';
  }

  function resolveTitle() {
    if (overrides.title && overrides.title.trim()) return overrides.title.trim().slice(0, 120);
    return (state.config && typeof state.config.displayName === 'string' && state.config.displayName) || 'Chat';
  }

  function mountShell() {
    var host = document.createElement('div');
    host.setAttribute('data-agent-embed', agentId);
    document.body.appendChild(host);
    state.host = host;
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '.ae-wrap { position: fixed; bottom: 24px; z-index: 2147483000; display: flex; flex-direction: column; gap: 12px; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }',
      '.ae-wrap.right { right: 24px; align-items: flex-end; }',
      '.ae-wrap.left { left: 24px; align-items: flex-start; }',
      '.ae-launcher { border: none; border-radius: 999px; padding: 12px 18px; cursor: pointer; font-family: inherit; font-size: 14px; font-weight: 600; line-height: 1; color: #fff; background: var(--ae-color); box-shadow: 0 6px 24px rgba(0,0,0,.18); }',
      '.ae-launcher:focus-visible { outline: 3px solid var(--ae-color); outline-offset: 3px; }',
      '.ae-panel { display: none; width: min(var(--ae-w), calc(100vw - 48px)); height: min(var(--ae-h), calc(100vh - 120px)); border-radius: 12px; overflow: hidden; box-shadow: 0 8px 40px rgba(0,0,0,.2); background: #fff; }',
      '.ae-panel.open { display: block; }',
      '.ae-panel iframe { width: 100%; height: 100%; border: 0; display: block; }'
    ].join('\n');
    root.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'ae-wrap ' + resolvePosition();
    wrap.style.setProperty('--ae-color', resolveColor());
    wrap.style.setProperty('--ae-w', overrides.width + 'px');
    wrap.style.setProperty('--ae-h', overrides.height + 'px');

    var panel = document.createElement('div');
    panel.className = 'ae-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', resolveTitle());

    var launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'ae-launcher';
    launcher.textContent = resolveTitle();
    launcher.setAttribute('aria-expanded', 'false');
    launcher.addEventListener('click', toggle);

    wrap.appendChild(panel);
    wrap.appendChild(launcher);
    root.appendChild(wrap);

    state.panel = panel;
    state.launcher = launcher;
  }

  function ensureIframe(frameUrl) {
    if (state.iframe) return;
    var iframe = document.createElement('iframe');
    iframe.setAttribute('title', resolveTitle());
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.src = frameUrl;
    state.panel.appendChild(iframe);
    state.iframe = iframe;
  }

  function toggle() {
    if (state.open) close();
    else open();
  }

  function open() {
    state.open = true;
    state.panel.classList.add('open');
    state.launcher.setAttribute('aria-expanded', 'true');
    if (state.frameUrl) ensureIframe(state.frameUrl);
  }

  function close() {
    state.open = false;
    state.panel.classList.remove('open');
    state.launcher.setAttribute('aria-expanded', 'false');
  }

  function sendToken() {
    if (!state.iframe || !state.iframe.contentWindow || !state.token) return;
    state.iframe.contentWindow.postMessage(
      { source: MSG_SOURCE, type: 'token', token: state.token, expiresAt: state.tokenExpiresAt },
      base
    );
  }

  function mintSession() {
    return request(agentPath + '/session', 'POST', {}).then(function (session) {
      if (!session || typeof session.token !== 'string' || session.token.length > 4096) {
        throw new Error('invalid session response');
      }
      var expiresMs = Date.parse(session.expiresAt);
      if (isNaN(expiresMs)) throw new Error('invalid session expiry');
      if (typeof session.frameUrl !== 'string' || session.frameUrl.indexOf(base + agentPath + '/frame') !== 0) {
        throw new Error('frame URL must stay on the platform origin');
      }
      state.token = session.token;
      state.tokenExpiresAt = expiresMs;
      state.frameUrl = session.frameUrl;
      sendToken();
      scheduleRefresh();
      if (state.open) ensureIframe(state.frameUrl);
    });
  }

  function scheduleRefresh() {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    var delay = Math.max(5000, state.tokenExpiresAt - Date.now() - REFRESH_LEAD_MS);
    state.refreshTimer = setTimeout(function () {
      mintSession().catch(function (err) {
        warn('could not refresh session' + (err && err.status ? ' (HTTP ' + err.status + ')' : '') + '.');
      });
    }, delay);
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== base) return;
    if (!state.iframe || event.source !== state.iframe.contentWindow) return;
    var data = event.data;
    if (!data || data.source !== MSG_SOURCE) return;
    if (data.type === 'ready') {
      sendToken();
    } else if (data.type === 'close') {
      close();
    }
  });

  function teardown() {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host);
    state.host = null;
  }

  request(agentPath + '/config', 'GET')
    .then(function (config) {
      if (!config || config.enabled !== true) throw new Error('agent unavailable');
      state.config = config;
      mountShell();
      return mintSession();
    })
    .catch(function (err) {
      // Fail closed: remove anything drawn and render nothing. Log only the status code,
      // never the response body.
      teardown();
      warn('agent unavailable' + (err && err.status ? ' (HTTP ' + err.status + ')' : '') + '.');
    });
})();
