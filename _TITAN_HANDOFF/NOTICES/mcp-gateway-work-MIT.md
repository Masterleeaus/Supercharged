# NOTICE: mcp-gateway-work (MIT)

Source: https://github.com/Aureo-Bueno/mcp-gateway-work
Copyright (c) 2026 Aureo Bueno
License: MIT

Reference consulted: `src/services/auditLog.ts`. In this revision that file does not
contain a hash chain. No code was copied from it into `server/services/audit-chain.mjs`
or `server/services/audit-log.ts`. The chain design (sha256 over canonical JSON plus the
previous entry hash) was written for this project. If any code is later ported from the
source, the MIT copyright and permission notice must be retained with that code.

## server/services/redaction.ts and tests/services/redaction.test.mjs

Source: `src/services/redaction.ts` and `tests/services/redaction.test.ts` in the
same repository (https://github.com/Aureo-Bueno/mcp-gateway-work).
Copyright (c) 2026 Aureo Bueno. License: MIT.

The redaction patterns, key-suffix list, and the `redactString`, `isSensitiveKey`,
`redactToolResult` and `redactArguments` functions are ported from the source. Test
assertions are ported from the Jest tests to `node:test`. One deliberate change: the
walker returns `Date` values unchanged instead of converting them to `{}`.

The MIT copyright and permission notice above applies to this code.

MIT License

Copyright (c) 2026 Aureo Bueno

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
