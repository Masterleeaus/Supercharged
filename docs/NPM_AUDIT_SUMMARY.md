# npm Audit Summary

Generated from `npm audit --json` and `npm audit --omit=dev --json` run in `/home/claude/desk-review` on 2026-11-03. Both commands exit 1 when vulnerabilities are found, which is expected. No dependency was changed: `npm audit fix` was not run, and `package.json` and `package-lock.json` are untouched.

## Totals by severity

| Severity | All dependencies | Production only (`--omit=dev`) | Dev-only |
|---|---|---|---|
| Critical | 1 | 1 | 0 |
| High | 22 | 21 | 1 |
| Moderate | 25 | 24 | 1 |
| Low | 1 | 1 | 0 |
| Info | 0 | 0 | 0 |
| **Total** | **49** | **47** | **2** |

Packages with a critical or high finding: 23.

## Dev-only findings

Only these packages are missing from the production audit. Both are listed in `devDependencies`, so they do not ship at runtime:

- `vite` (high, direct devDependency, installed 6.4.3): dev-server issues such as file access outside `server.fs.allow` and editor-launch command handling.
- `@tailwindcss/typography` (moderate, direct devDependency): not critical or high, so it is not in the table below.

Everything else in the critical and high table is in the production dependency tree.

## Critical and high entries

Each row is one advisory. Packages with no advisory of their own inherit severity from a dependency. "Fix" is the version npm reports, or the lowest version that clears the advisory's vulnerable range when npm's JSON does not state a version. Verify the exact version with `npm view <pkg> versions` before upgrading.

| Severity | Package | Installed | Scope | Advisory title | Advisory | Vulnerable range | Fix |
|---|---|---|---|---|---|---|---|
| critical | `proxy-addr` (transitive) | 2.0.7 | prod | proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) | >=1.1.0 <2.0.8 | >=2.0.8 |
| high | `@modelcontextprotocol/sdk` (transitive) | 1.30.0 | prod | MCP TypeScript SDK: Experimental tasks were not tied to the session that created them | [GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw) | >=1.24.0 <1.32.0 | >=1.32.0 |
| high | `@modelcontextprotocol/sdk` (transitive) | 1.30.0 | prod | MCP TypeScript SDK: HTTP server transports and handlers did not limit request body size or JSON-RPC batch length | [GHSA-f897-62hf-6gxq](https://github.com/advisories/GHSA-f897-62hf-6gxq) | >=1.10.0 <1.30.1 | >=1.32.0 |
| high | `@modelcontextprotocol/sdk` (transitive) | 1.30.0 | prod | MCP TypeScript SDK: OAuth client could send credentials to an authorization server chosen by the MCP server | [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) | >=1.12.0 <1.31.0 | >=1.32.0 |
| high | `@modelcontextprotocol/sdk` (transitive) | 1.30.0 | prod | MCP TypeScript SDK: One HTTP request within the default size limit could exhaust server memory during validation | [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) | >=1.3.0 <1.32.0 | >=1.32.0 |
| high | `adm-zip` (direct) | 0.6.0 | prod | adm-zip extraction preserves SUID/SGID bits from untrusted ZIPs -> local privilege escalation | [GHSA-j5f4-cc29-5x44](https://github.com/advisories/GHSA-j5f4-cc29-5x44) | <=0.6.0 | >=0.6.1 |
| high | `adm-zip` (direct) | 0.6.0 | prod | adm-zip: Decompression-bomb protection (fix for CVE-2026-39244) can be bypassed by declaring uncompressed size as 0 | [GHSA-rcw4-f5rp-g42v](https://github.com/advisories/GHSA-rcw4-f5rp-g42v) | <=0.6.0 | >=0.6.1 |
| high | `adm-zip` (direct) | 0.6.0 | prod | adm-zip: Uncontrolled memory allocation via the declared uncompressed size (DoS) | [GHSA-7q85-xj36-vmfc](https://github.com/advisories/GHSA-7q85-xj36-vmfc) | <0.6.1 | >=0.6.1 |
| high | `adm-zip` (direct) | 0.6.0 | prod | adm-zip: Unhandled error event in async DEFLATE decompression crashes Node.js process (DoS) | [GHSA-8238-w5pm-2374](https://github.com/advisories/GHSA-8238-w5pm-2374) | <=0.6.0 | >=0.6.1 |
| high | `axios` (direct) | 1.19.0 | prod | Axios: Denial of Service via Unhandled 'error' Event in HTTP/2 ClientHttp2Session Initialization | [GHSA-542g-h47m-68v8](https://github.com/advisories/GHSA-542g-h47m-68v8) | >=1.13.0 <1.20.0 | >=1.20.0 |
| high | `axios` (direct) | 1.19.0 | prod | Axios: HTTP/2 adapter bypasses configured DNS lookup and proxy controls | [GHSA-3pq3-5fj3-cg6v](https://github.com/advisories/GHSA-3pq3-5fj3-cg6v) | >=1.13.0 <1.20.0 | >=1.20.0 |
| high | `axios` (direct) | 1.19.0 | prod | Axios: maxRedirects: 0 is not enforced by the fetch adapter, allowing redirect-based SSRF | [GHSA-r4gj-5m52-g5wh](https://github.com/advisories/GHSA-r4gj-5m52-g5wh) | >=1.17.0 <1.20.0 | >=1.20.0 |
| high | `axios` (direct) | 1.19.0 | prod | Axios: Node HTTP adapter prototype-pollution gadget allows request socket hijack via inherited createConnection | [GHSA-m8m8-qj5v-23w3](https://github.com/advisories/GHSA-m8m8-qj5v-23w3) | >=1.15.2 <1.20.0 | >=1.20.0 |
| high | `axios` (direct) | 1.19.0 | prod | Axios: Prototype Pollution Gadget in axios toFormData Options | [GHSA-x97p-jq2g-jp4f](https://github.com/advisories/GHSA-x97p-jq2g-jp4f) | >=1.15.1 <1.20.0 | >=1.20.0 |
| high | `axios` (direct) | 1.19.0 | prod | Axios: ReDoS (O(N²)) in shouldBypassProxy host normalization, reachable via untrusted redirect Location | [GHSA-mghh-pgcx-3jjj](https://github.com/advisories/GHSA-mghh-pgcx-3jjj) | >=1.15.0 <1.20.0 | >=1.20.0 |
| high | `axios` (direct) | 1.19.0 | prod | Axios: ReDoS in fromDataURI data: URL parser freezes the Node event loop (DoS) | [GHSA-c29m-xwm3-cm6r](https://github.com/advisories/GHSA-c29m-xwm3-cm6r) | >=1.16.1 <1.20.0 | >=1.20.0 |
| high | `basic-ftp` (transitive) | 6.0.1 | prod | basic-ftp: Quadratic-time CPU denial of service in Client.list() Unix directory-listing parser (RE_LINE backtracking) | [GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r) | <=6.2.0 | above 6.2.0 |
| high | `body-parser` (transitive) | 1.20.6 | prod | body-parser vulnerable to Denial of Service via trailing bytes after a compressed request body | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) | <1.20.9 | >=1.20.9 (1.x); >=2.4.0 (2.x) |
| high | `body-parser` (transitive) | 1.20.6 | prod | body-parser vulnerable to Denial of Service via trailing bytes after a compressed request body | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) | >=2.0.0 <2.4.0 | >=1.20.9 (1.x); >=2.4.0 (2.x) |
| high | `brace-expansion` (transitive) | 5.0.9 | prod | brace-expansion: DoS via uncontrolled recursion in parseCommaParts causing stack exhaustion | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | >=4.0.0 <5.0.10 | >=5.0.12 |
| high | `brace-expansion` (transitive) | 5.0.9 | prod | brace-expansion: DoS via uncontrolled recursion on nested brace groups causing stack exhaustion | [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | >=4.0.0 <5.0.11 | >=5.0.12 |
| high | `browserslist` (transitive) | 4.28.2 | prod | Browserslist: Unbounded memory growth (no cache eviction) via distinct query results, leading to eventual OOM | [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) | <=4.28.6 | above 4.28.6 |
| high | `browserslist` (transitive) | 4.28.2 | prod | Browserslist: Uncaught crash / prototype write via untrusted browserslist-stats.json custom stats (normalizeStats) | [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) | <=4.28.6 | above 4.28.6 |
| high | `compression` (direct) | 1.8.1 | prod | compression vulnerable to Denial of Service via memory leak on premature response close | [GHSA-vc2v-76pw-4v95](https://github.com/advisories/GHSA-vc2v-76pw-4v95) | <1.8.2 | >=1.8.2 |
| high | `fast-uri` (transitive) | 3.1.5 | prod | fast-uri vulnerable to authority injection via an unvalidated port in serialize | [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) | >=3.0.0 <3.1.7 | >=3.1.9 |
| high | `fast-uri` (transitive) | 3.1.5 | prod | fast-uri vulnerable to host confusion via percent-encoded scheme normalization | [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp) | >=3.0.0 <3.1.6 | >=3.1.9 |
| high | `fast-uri` (transitive) | 3.1.5 | prod | fast-uri vulnerable to host confusion via skipped IDN canonicalization on scheme-relative references | [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8) | >=3.1.3 <3.1.6 | >=3.1.9 |
| high | `fast-uri` (transitive) | 3.1.5 | prod | fast-uri vulnerable to server-side request forgery via malformed IPv6 normalization | [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc) | >=3.0.0 <3.1.6 | >=3.1.9 |
| high | `fast-uri` (transitive) | 3.1.5 | prod | fast-uri vulnerable to server-side request forgery via repeated hostname percent-decoding | [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf) | >=3.1.2 <3.1.6 | >=3.1.9 |
| high | `follow-redirects` (transitive) | 1.16.0 | prod | follow-redirects array-form headers bypass cross-origin credential stripping | [GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8) | >=1.16.0 <1.16.1 | above 1.16.1 |
| high | `follow-redirects` (transitive) | 1.16.0 | prod | follow-redirects sensitiveHeaders regex escaping can expose credential headers | [GHSA-8r9p-f939-6h3c](https://github.com/advisories/GHSA-8r9p-f939-6h3c) | >=1.16.0 <1.16.1 | above 1.16.1 |
| high | `follow-redirects` (transitive) | 1.16.0 | prod | follow-redirects: Cross-realm sensitiveHeaders arrays are discarded and custom credentials can follow redirects | [GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p) | >=1.16.0 <=1.16.1 | above 1.16.1 |
| high | `get-uri` (transitive) | 6.0.5 | prod | Inherited from basic-ftp (no own advisory entry) | n/a | >=5.0.0 | npm reports fix; version not given (fix comes via basic-ftp) |
| high | `joi` (transitive) | 17.13.4 | prod | joi: Quadratic regular-expression backtracking in `Joi.string().isoDate()` | [GHSA-6h2x-m376-mqjq](https://github.com/advisories/GHSA-6h2x-m376-mqjq) | >=17.2.0 <17.13.7 | >=17.13.9 |
| high | `joi` (transitive) | 17.13.4 | prod | joi: quadratic-time split in `string().email({ multiple: true })` allows denial of service | [GHSA-4528-x5fx-h6hg](https://github.com/advisories/GHSA-4528-x5fx-h6hg) | >=17.1.1 <17.13.9 | >=17.13.9 |
| high | `multer` (direct) | 2.2.0 | prod | multer vulnerable to Denial of Service via a pending asynchronous fileFilter after request teardown | [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) | >=2.0.0 <2.5.0 | >=2.5.0 |
| high | `multer` (direct) | 2.2.0 | prod | multer vulnerable to Denial of Service via crafted multipart field names | [GHSA-wc9g-mqfw-jrwm](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm) | <2.3.0 | >=2.5.0 |
| high | `multer` (direct) | 2.2.0 | prod | multer vulnerable to Denial of Service via file descriptor leak on aborted uploads | [GHSA-qfvm-cv95-jqjf](https://github.com/advisories/GHSA-qfvm-cv95-jqjf) | =2.2.0 | >=2.5.0 |
| high | `multer` (direct) | 2.2.0 | prod | multer vulnerable to Denial of Service via oversized array index in field names | [GHSA-535w-7cp7-47q4](https://github.com/advisories/GHSA-535w-7cp7-47q4) | <2.3.0 | >=2.5.0 |
| high | `nanoid` (transitive) | 3.3.17 | prod | nanoid: custom generators can loop indefinitely when size is zero | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | <3.3.18 | >=3.3.18 |
| high | `nodemailer` (direct) | 9.0.4 | prod | Nodemailer: Quadratic (O(n²)) time complexity in addressparser allows remote denial of service via a crafted address list | [GHSA-2x7j-588g-ccc2](https://github.com/advisories/GHSA-2x7j-588g-ccc2) | <9.1.0 | npm reports fix; advisory bounds reach 10.1.4 (may be a major bump from 9.x) |
| high | `nodemailer` (direct) | 9.0.4 | prod | Nodemailer: Quadratic backtracking in the addressparser free-text fallback allows remote denial of service | [GHSA-v53p-9fqp-m79j](https://github.com/advisories/GHSA-v53p-9fqp-m79j) | <=10.0.5 | npm reports fix; advisory bounds reach 10.1.4 (may be a major bump from 9.x) |
| high | `pac-proxy-agent` (transitive) | 7.2.0 | prod | Inherited from get-uri (no own advisory entry) | n/a | >=6.0.0 | npm reports fix; version not given (transitive via get-uri) |
| high | `pm2` (direct) | 7.0.3 | prod | Inherited from proxy-agent (no own advisory entry) | n/a | 7.0.0 - 7.0.4 | npm reports fix; version not given (transitive via proxy-agent) |
| high | `proxy-agent` (transitive) | 6.5.0 | prod | Inherited from pac-proxy-agent (no own advisory entry) | n/a | >=6.0.0 | npm reports fix; version not given (transitive via pac-proxy-agent) |
| high | `source-map-js` (transitive) | 1.2.1 | prod | source-map-js allows event-loop denial of service through indexed source-map section offsets | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | >=1.0.0 <1.2.2 | >=1.2.2 |
| high | `vite` (direct) | 6.4.3 | dev-only | launch-editor: `fs.existsSync()` existence check can be bypassed on Windows | [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) | <=6.4.3 | above 6.4.3 (npm reports fix; version not given) |
| high | `zod` (direct) | 3.25.76 | prod | Zod can exhaust memory while validating oversized constrained collections | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | <4.6.6 | 4.6.7 (semver-major from 3.x) |
| high | `zod-validation-error` (direct) | 3.5.4 | prod | Inherited from zod (no own advisory entry) | n/a | <=4.0.0-beta.2 | 5.0.0 (semver-major) |

## Packages to address first

- `proxy-addr` (critical, transitive): IP spoofing via an IPv4-mapped IPv6 trust subnet. Fix is `>=2.0.8`.
- `@modelcontextprotocol/sdk` (6 high advisories, transitive): fix is `>=1.32.0`.
- `zod` and `zod-validation-error` (direct): fixes are semver-major (`zod@4.6.7`, `zod-validation-error@5.0.0`), so they need code review.
- `axios`, `adm-zip`, `multer`, `compression`, `nodemailer`, `joi`, `fast-uri`, `brace-expansion` (direct or widely used): patch or minor upgrades are available within the listed fix ranges, but check each for API changes.
- `nodemailer` has advisories whose ranges reach `10.1.4` from `9.0.4`, so it may need a major bump.
