# Mastra attribution: Cohere reranker (issue #380)

This page records where the VoltAgent Phase 1 reranker comes from and what was taken from it.

## Source

- Project: https://github.com/mastra-ai/mastra
- File read: `packages/rag/src/rerank/relevance/cohere/index.ts`
- Commit read: `b9d38c73982210c6564ee8a33d992a238e29a20b` (shallow clone, 2026-11-18)
- Licence: Apache License 2.0, Copyright (c) 2025 Kepler Software, Inc. The file is outside the `ee/` directories, so the Apache-2.0 terms apply.

## Our module

- `server/integrations/voltagent/rerank/cohere-reranker.ts`
- Tests: `tests/integrations/voltagent/rerank.test.mjs` (11 tests, fetch mocked, no network)
- Guard test for this page: `tests/integrations/voltagent/rerank-attribution.test.mjs`

## What we follow from the Mastra file

- The endpoint: `POST {base}/v2/rerank`.
- The default model name and the Bearer authorization header.
- The request fields `model`, `query`, `documents` and `top_n`.
- The response shape `results[] { index, relevance_score }`.
- An API key is required before any request is sent.

## Differences (our code is not a verbatim copy)

- Mastra scores one document per call (`documents: [text]`, `top_n: 1`). Our module sends a whole list and returns every result sorted by score.
- Mastra returns one number. Our module returns `{ index, score }` items.
- Our module checks each response field and throws fixed error codes (`rerank_failed`, `rerank_timeout`, `rerank_response_invalid`, `rerank_input_invalid`). Errors never include the key or the response body.
- Our module adds a timeout (default 10 s), input limits (2000 query characters, 1000 documents) and an injectable fetch.

## Not verified

- The live Cohere API is not called. The response shape follows the Mastra file, not a live check.

## Copied code

- No Mastra source is copied verbatim. The attribution covers the endpoint and response shape that the module follows.
