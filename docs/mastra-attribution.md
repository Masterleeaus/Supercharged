# Mastra attribution for the VoltAgent integration

Status: technical provenance checked on 2026-11-18. Not a legal opinion. Counsel review is still required before the paid launch of Desk (issue #395, owner-only item).

## What this covers

The VoltAgent integration lives in `server/integrations/voltagent/`. Its NOTICE is `server/integrations/voltagent/NOTICE.md`. The Mastra reference rules are in `source/mastra-apache-only/README.md`, which points here for attribution.

## Finding

No Mastra source code is copied into the integration. Every file in W5 (`vector-pg/`, `rag/`) and W6 (`rerank/`) is written from scratch, and each file header says so. The verbatim scan below found no shared line in any of the 17 files.

Files in the W5 and W6 scope:

- `server/integrations/voltagent/vector-pg/pg-vector-store.ts` (issue #379). Written from scratch.
- `server/integrations/voltagent/vector-pg/sql.ts` (issue #379). Written from scratch. The file header says the Mastra sql-builder was not fetched.
- `server/integrations/voltagent/rerank/cohere-reranker.ts` (issue #380). Written from the public Cohere rerank API shape. Compared with `packages/rag/src/rerank/relevance/cohere/index.ts`. The two share the endpoint and the response field names, which are the public API. No code is shared.
- `server/integrations/voltagent/rag/*.ts` (W5 RAG). Written from scratch.

## Reproducible baseline

Reference: Mastra `mastra-ai/mastra` at commit `b9d38c73982210c6564ee8a33d992a238e29a20b` (shallow clone, 2026-11-18).

```bash
git clone --depth 1 https://github.com/mastra-ai/mastra /path/to/mastra
node scripts/check-voltagent-provenance.mjs /path/to/mastra
```

Result on that commit: 0 verbatim lines in 17 files; 11,963 reference files scanned. Exit code 0.

The script matches any line of 50 or more characters (whitespace trimmed). It is a line-level check. It does not detect a copy that was reworded, so it is evidence and not proof. Structural similarity is covered by the file headers and by review.

## Rules for any future copy

1. Copy only Apache-2.0 files. Never copy anything under an `ee/` directory. Gate G1 (`scripts/check-voltagent-licence.mjs`) enforces this for paths and imports.
2. Keep the original copyright and licence header in each copied file. Mark the change in the file header.
3. Add the copied file to `server/integrations/voltagent/NOTICE.md` with its upstream path and commit.
4. Run `scripts/check-voltagent-provenance.mjs` against the upstream checkout. It must report 0 lines for files that claim to be original.
5. Record the decision in `/home/claude/supercharged-fixes-checklist.md`.

## Attribution text

If a file is copied, the upstream licence text and copyright line must stay with it. The Mastra snapshot README (`source/mastra-apache-only/README.md`) records the copyright line `Copyright (c) 2025 Kepler Software, Inc.` for Apache-2.0 files. That line must be checked against the upstream LICENSE before any copy is shipped. No copy exists today, so no attribution line is needed in the shipped code.

## Owner-only item

Counsel review of this document and of `NOTICE.md` before the paid launch. The repo cannot close this item.
