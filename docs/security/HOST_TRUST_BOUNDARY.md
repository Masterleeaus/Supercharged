# Host-based mode resolution — Pass 4

Desk mode host matching uses an exact configured allowlist. The trusted raw Host header is normalised, with numeric ports restricted to 1–65535. A repeated Host header, unknown hostname, invalid port, path, URL scheme, userinfo, or forwarded-host spoof must not grant a module.

The mode middleware clears stale mode properties before checking each request. Unknown hosts return 404. On the authenticated mode discovery endpoint, responses are private and non-cacheable. The browser recognizes a mode only if the response carries `source: host`.

**Deployment requirement:** Configure the reverse proxy with a canonical Host value, do not trust client-supplied forwarded host headers for mode selection, and isolate runtime domains. Host mode is not a replacement for tenant membership and role-based authorization.
