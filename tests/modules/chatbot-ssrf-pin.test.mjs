// SSRF connect pin (audit item C5) and redirect rules for URL fetches. node:test, no network.
// The resolver is a stub and the transport is a fake requester, so no socket is opened.
// Covers: DNS rebind, a private address in the resolved list, redirects to the metadata address, 307 and 308
// followed, 301 and 302 refused, the hop limit of 3, the Host header and TLS servername, and the webhook guard.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as k from "../../server/modules/chatbot/knowledge/index.ts";
import { createPinnedHttpClient } from "../../server/modules/chatbot/knowledge/pinned-http.ts";
import { checkPublicWebhookTarget, assertPublicWebhookUrl, WebhookUrlRefusedError } from "../../server/modules/chatbot/events/ssrf.ts";

const PUBLIC_IP = "93.184.216.34";
const OTHER_PUBLIC_IP = "151.101.1.69";
const METADATA_IP = "169.254.169.254";

/** Resolver stub. Each call returns the next answer in the list, then keeps returning the last one. */
function scriptedResolver(...answers) {
  const seen = [];
  const resolve = async (hostname) => {
    seen.push(hostname);
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { resolve, seen };
}

/**
 * Fake node:http / node:https request. respond(options) returns { status, headers, body }, { error: true }, or
 * { hang: true }. Every call is recorded with the options it was given.
 */
function fakeRequester(respond, calls = []) {
  const requester = (options, onResponse) => {
    const call = { options, body: undefined };
    calls.push(call);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (body) => {
      call.body = body;
      setImmediate(() => {
        const out = respond(options);
        if (out.hang) return;
        if (out.error) {
          req.emit("error", new Error("socket reset"));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = out.status;
        res.headers = out.headers ?? {};
        res.destroy = () => {};
        onResponse(res);
        if (out.body !== undefined) res.emit("data", Buffer.from(out.body, "utf8"));
        res.emit("end");
      });
    };
    return req;
  };
  return { requester, calls };
}

/** Builds the pinned client with the fake transport for both schemes. */
function pinnedClient({ resolve, respond = () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<p>ok</p>" }), maxBodyBytes, calls }) {
  // Each scheme gets its own call list unless the caller passes a shared one.
  const https = fakeRequester(respond, calls ?? []);
  const http = fakeRequester(respond, calls ?? []);
  const client = createPinnedHttpClient({
    resolve,
    maxBodyBytes: maxBodyBytes ?? k.DEFAULT_MAX_FETCH_BYTES,
    transport: { https: https.requester, http: http.requester },
  });
  return { client, https, http, calls };
}

const getRequest = (url, timeoutMs = 1000) => ({ method: "GET", url, timeoutMs });

// ---------- connect pin ----------

test("pinned client connects to the checked address, not the name, and keeps the Host header and servername", async () => {
  const { resolve, seen } = scriptedResolver([PUBLIC_IP]);
  const { client, https, http } = pinnedClient({ resolve });

  const response = await client(getRequest("https://example.com/docs?x=1"));

  assert.equal(response.status, 200);
  assert.equal(https.calls.length, 1);
  assert.equal(http.calls.length, 0);
  const options = https.calls[0].options;
  assert.equal(options.host, PUBLIC_IP, "the socket goes to the checked address");
  assert.equal(options.port, 443);
  assert.equal(options.path, "/docs?x=1");
  assert.equal(options.headers.host, "example.com", "the Host header is the original name");
  assert.equal(options.servername, "example.com", "TLS checks the original name, not the IP");
  assert.equal(options.agent, false, "no pooled socket can carry an earlier address");
  assert.deepEqual(seen, ["example.com"], "the name is resolved exactly once per request");
});

test("DNS rebind: the second answer is private, but the connect still uses the first checked address", async () => {
  // The first answer is public and the second would be the metadata address. The client resolves once, so the
  // second answer is never seen and the connect goes to the checked address.
  const { resolve, seen } = scriptedResolver([PUBLIC_IP], [METADATA_IP]);
  const { client, https } = pinnedClient({ resolve });

  await client(getRequest("https://rebind.example.com/"));

  assert.equal(seen.length, 1, "no second lookup at connect time");
  assert.equal(https.calls[0].options.host, PUBLIC_IP);
  assert.notEqual(https.calls[0].options.host, METADATA_IP);
});

test("a private address anywhere in the resolved list refuses the request and opens no socket", async () => {
  const { resolve } = scriptedResolver([PUBLIC_IP, "10.0.0.5"]);
  const { client, https, http } = pinnedClient({ resolve });

  await assert.rejects(client(getRequest("https://mixed.example.com/")), (e) => e.name === "UrlRefusedError" && e.reason === "address");
  assert.equal(https.calls.length + http.calls.length, 0, "nothing is connected when any address is blocked");
});

test("a resolved metadata address refuses the request", async () => {
  const { resolve } = scriptedResolver([METADATA_IP]);
  const { client, https } = pinnedClient({ resolve });
  await assert.rejects(client(getRequest("https://meta.example.com/")), (e) => e.reason === "address");
  assert.equal(https.calls.length, 0);
});

test("a lookup failure refuses the request and opens no socket", async () => {
  const { resolve } = scriptedResolver(new Error("ENOTFOUND"));
  const { client, https } = pinnedClient({ resolve });
  await assert.rejects(client(getRequest("https://gone.example.com/")), (e) => e.reason === "resolution");
  assert.equal(https.calls.length, 0);
});

test("an IP literal is checked and connected directly, with no servername", async () => {
  const { resolve, seen } = scriptedResolver([PUBLIC_IP]);
  const { client, https } = pinnedClient({ resolve });
  await client(getRequest(`https://${PUBLIC_IP}/`));
  assert.equal(seen.length, 0, "a literal never reaches DNS");
  assert.equal(https.calls[0].options.host, PUBLIC_IP);
  assert.equal(https.calls[0].options.servername, undefined);
});

test("http uses the plain transport on port 80 with no TLS servername", async () => {
  const { resolve } = scriptedResolver([PUBLIC_IP]);
  const { client, https, http } = pinnedClient({ resolve });
  await client(getRequest("http://example.com/"));
  assert.equal(https.calls.length, 0);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].options.port, 80);
  assert.equal(http.calls[0].options.host, PUBLIC_IP);
  assert.equal(http.calls[0].options.headers.host, "example.com");
  assert.equal(http.calls[0].options.servername, undefined);
});

test("a caller host header cannot replace the pinned Host", async () => {
  const { resolve } = scriptedResolver([PUBLIC_IP]);
  const { client, https } = pinnedClient({ resolve });
  await client({ method: "GET", url: "https://example.com/", timeoutMs: 1000, headers: { Host: "evil.example" } });
  assert.equal(https.calls[0].options.headers.host, "example.com");
  assert.equal(https.calls[0].options.headers.Host, undefined);
});

test("a transport error and a timeout are reported without the URL", async () => {
  const { resolve } = scriptedResolver([PUBLIC_IP]);
  const failing = pinnedClient({ resolve, respond: () => ({ error: true }) });
  await assert.rejects(failing.client(getRequest("https://example.com/secret-path")), (e) => e.kind === "network" && !String(e.message).includes("secret-path"));

  const hanging = pinnedClient({ resolve, respond: () => ({ hang: true }) });
  await assert.rejects(hanging.client(getRequest("https://example.com/", 20)), (e) => e.kind === "timeout");
});

test("response bodies are cut off after maxBodyBytes", async () => {
  const { resolve } = scriptedResolver([PUBLIC_IP]);
  const { client } = pinnedClient({ resolve, maxBodyBytes: 10, respond: () => ({ status: 200, body: "x".repeat(500) }) });
  const response = await client(getRequest("https://example.com/"));
  assert.ok(Buffer.byteLength(response.body, "utf8") > 10, "the cut body is over the cap, so the caller refuses it as too large");
  assert.ok(Buffer.byteLength(response.body, "utf8") <= 11);
});

// ---------- redirect rules through fetchPublicPage ----------

/** Pinned client wired to a route table keyed by request URL. Unknown routes return 500. */
function routedFetch(routes, resolve = scriptedResolver([PUBLIC_IP]).resolve) {
  const respond = (options) => {
    const scheme = options.servername ? "https" : "http";
    const url = `${scheme}://${options.headers.host}${options.path}`;
    const route = routes[url];
    return route ?? { status: 500, headers: {}, body: "" };
  };
  const calls = [];
  const { client } = pinnedClient({ resolve, respond, calls });
  return { client, calls };
}

const redirectTo = (status, location) => ({ status, headers: { location }, body: "" });
const OK_PAGE = { status: 200, headers: { "content-type": "text/html" }, body: "<title>T</title><p>hi</p>" };

test("a 307 redirect to a public page is followed", async () => {
  const { client, calls } = routedFetch({
    "https://example.com/": redirectTo(307, "https://example.com/next"),
    "https://example.com/next": OK_PAGE,
  });
  const page = await k.fetchPublicPage("https://example.com/", { http: client, resolve: scriptedResolver([PUBLIC_IP]).resolve, timeoutMs: 1000 });
  assert.equal(page.url, "https://example.com/next");
  assert.equal(calls.length, 2);
});

test("a 308 redirect to a public page is followed", async () => {
  const { client } = routedFetch({
    "https://example.com/": redirectTo(308, "https://example.com/moved"),
    "https://example.com/moved": OK_PAGE,
  });
  const page = await k.fetchPublicPage("https://example.com/", { http: client, resolve: scriptedResolver([PUBLIC_IP]).resolve, timeoutMs: 1000 });
  assert.equal(page.url, "https://example.com/moved");
});

test("a 301 redirect is refused and its target is never requested", async () => {
  const { client, calls } = routedFetch({
    "https://example.com/": redirectTo(301, "https://example.com/next"),
    "https://example.com/next": OK_PAGE,
  });
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http: client, resolve: scriptedResolver([PUBLIC_IP]).resolve, timeoutMs: 1000 }),
    (e) => e.code === "url_refused",
  );
  assert.equal(calls.length, 1);
});

test("a 302 redirect is refused", async () => {
  const { client, calls } = routedFetch({ "https://example.com/": redirectTo(302, "https://example.com/next") });
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http: client, resolve: scriptedResolver([PUBLIC_IP]).resolve, timeoutMs: 1000 }),
    (e) => e.code === "url_refused",
  );
  assert.equal(calls.length, 1);
});

test("a 307 redirect to the metadata address is refused before any request is sent to it", async () => {
  const { client, calls } = routedFetch({
    "https://example.com/": redirectTo(307, "http://169.254.169.254/latest/meta-data/"),
  });
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http: client, resolve: scriptedResolver([PUBLIC_IP]).resolve, timeoutMs: 1000 }),
    (e) => e.code === "url_refused",
  );
  assert.equal(calls.length, 1, "only the public hop was requested");
  assert.ok(!calls.some((c) => c.options.host === METADATA_IP));
});

test("a redirect to a name that resolves to a private address is refused at the next hop", async () => {
  const resolve = async (hostname) => (hostname === "internal-alias.example.net" ? ["10.1.2.3"] : [PUBLIC_IP]);
  const { client, calls } = routedFetch(
    { "https://example.com/": redirectTo(307, "https://internal-alias.example.net/") },
    resolve,
  );
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http: client, resolve, timeoutMs: 1000 }),
    (e) => e.code === "url_refused",
  );
  assert.equal(calls.length, 1);
});

test("three 307 hops are allowed and the fourth is refused (hop limit 3)", async () => {
  const three = routedFetch({
    "https://example.com/": redirectTo(307, "https://example.com/a"),
    "https://example.com/a": redirectTo(307, "https://example.com/b"),
    "https://example.com/b": redirectTo(308, "https://example.com/c"),
    "https://example.com/c": OK_PAGE,
  });
  const page = await k.fetchPublicPage("https://example.com/", { http: three.client, resolve: scriptedResolver([PUBLIC_IP]).resolve, timeoutMs: 1000 });
  assert.equal(page.url, "https://example.com/c");
  assert.equal(three.calls.length, 4);

  const four = routedFetch({
    "https://example.com/": redirectTo(307, "https://example.com/a"),
    "https://example.com/a": redirectTo(307, "https://example.com/b"),
    "https://example.com/b": redirectTo(307, "https://example.com/c"),
    "https://example.com/c": redirectTo(307, "https://example.com/d"),
    "https://example.com/d": OK_PAGE,
  });
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http: four.client, resolve: scriptedResolver([PUBLIC_IP]).resolve, timeoutMs: 1000 }),
    (e) => e.code === "fetch_failed" && /Too many redirects/.test(e.message),
  );
  assert.equal(four.calls.length, 4, "no fifth request is made");
});

test("a 307 with no location is a fetch failure", async () => {
  const { client } = routedFetch({ "https://example.com/": { status: 307, headers: {}, body: "" } });
  await assert.rejects(
    k.fetchPublicPage("https://example.com/", { http: client, resolve: scriptedResolver([PUBLIC_IP]).resolve, timeoutMs: 1000 }),
    (e) => e.code === "fetch_failed",
  );
});

// ---------- the knowledge guard itself ----------

test("checkPublicHttpTarget returns the addresses it checked, and the pinned client uses one of them", async () => {
  const resolver = scriptedResolver([PUBLIC_IP, OTHER_PUBLIC_IP]);
  const target = await k.checkPublicHttpTarget("https://example.com/", resolver.resolve);
  assert.deepEqual([...target.addresses], [PUBLIC_IP, OTHER_PUBLIC_IP]);
  assert.equal(target.url.hostname, "example.com");
});

test("non-http schemes, credentials and other ports are refused before any resolution", async () => {
  const resolver = scriptedResolver([PUBLIC_IP]);
  for (const url of ["ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "https://example.com:8443/"]) {
    await assert.rejects(k.checkPublicHttpTarget(url, resolver.resolve), (e) => e.name === "UrlRefusedError", url);
  }
  assert.equal(resolver.seen.length, 0);
});

// ---------- the webhook guard ----------

test("checkPublicWebhookTarget returns the checked addresses and refuses a private one in the list", async () => {
  const ok = await checkPublicWebhookTarget("https://hooks.example.com/in", async () => [PUBLIC_IP]);
  assert.deepEqual([...ok.addresses], [PUBLIC_IP]);
  assert.equal(ok.url.hostname, "hooks.example.com");

  await assert.rejects(
    checkPublicWebhookTarget("https://hooks.example.com/in", async () => [PUBLIC_IP, "192.168.1.9"]),
    (e) => e instanceof WebhookUrlRefusedError && e.reason === "address",
  );
});

test("assertPublicWebhookUrl still refuses the metadata literal and returns the URL for a public host", async () => {
  await assert.rejects(assertPublicWebhookUrl(`https://${METADATA_IP}/`, async () => []), (e) => e.reason === "address");
  const url = await assertPublicWebhookUrl("https://hooks.example.com/in", async () => [PUBLIC_IP]);
  assert.equal(url.toString(), "https://hooks.example.com/in");
});
