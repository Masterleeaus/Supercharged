# Knowledge slice: decisions

Port of the Commerce Crew knowledge base (PHP) into the Desk chatbot module. Scope: chunking, embedding through
the `ModelProvider` contract, storage in Drizzle, cosine retrieval in app code, a `Retriever`, and a URL fetch
with an SSRF guard. Article CRUD and canned responses belong to another agent and are not here.

PHP source (read only): `extensions/chatbot/System/Services/TrainingService.php`, `Tools/KnowledgeBase.php`,
`Embedders/OpenAIEmbedder.php`, `Services/OpenAI/EmbedingService.php`, `Http/Controllers/ChatbotTrainController.php`,
`Parsers/LinkParser.php`, `Parsers/TextParser.php`, `Parsers/ExcelParser.php`, `Parsers/PdfParser.php`.

## Files

| File | Purpose | PHP source |
|---|---|---|
| `chunking.ts` | Paragraph, sentence and word chunking, token estimate, content hash, deterministic chunk id | `EmbedingService::splitIntoChunks` |
| `cosine.ts` | Cosine similarity | `KnowledgeBase::cosineSimilarity` |
| `ssrf.ts` | Public-address check for URLs, IPv4 and IPv6 | none (PHP had no guard) |
| `url-source.ts` | Page fetch with per-hop checks, HTML to text, same-host crawl | `LinkParser` |
| `embedding.ts` | Batched embedding through `ModelProvider`, vector shape checks | `OpenAIEmbedder`, `EmbedingService::generateEmbedding` |
| `retriever.ts` | `KnowledgeRetriever` (implements `Retriever`), candidate reader port | `KnowledgeBase::call` |
| `indexer.ts` | Text, Q&A, file, URL and article indexing; delete | `ChatbotTrainController` train methods, `TrainingService` |
| `memory-storage.ts` | In-memory `KnowledgeStorage` and candidate reader (reference behaviour) | none |
| `drizzle-storage.ts` | Drizzle `KnowledgeStorage` and candidate reader | none |
| `errors.ts` | `KnowledgeError` (extends `ChatbotError`), redacted messages | none |
| `index.ts` | Barrel | none |
| `../db/knowledge.ts` | Drizzle tables `chatbot_knowledge_sources`, `_chunks`, `_embeddings` | `ext_chatbot_embeddings` migrations |
| `../db/migrations-draft/0010_knowledge.sql` | Draft SQL for the three tables (not applied) | same |

## Decisions that change behaviour

1. **Chunk size.** Target 512 estimated tokens (4 characters per token). The PHP used a 1024 byte limit with a
   space split. Splitting now goes paragraph, then sentence, then word. A run longer than the limit is cut
   into pieces. No overlap, as in the PHP.
2. **One row per chunk.** The PHP stored one row per source with a JSON array of chunk embeddings. Chunks and
   embeddings are now rows, so a delete removes them with the source.
3. **Embedding model is recorded.** Each embedding stores provider, model and dimensions. Retrieval compares only
   rows whose model matches the query's model exactly. The PHP stored no model.
4. **Chunk ids are deterministic.** `replaceChunks` takes chunks without ids, but embeddings must name their chunk.
   The id is `sha256(sourceId, ordinal, chunk hash)`, computed the same way by the indexer and the storage. See
   change request 1.
5. **Re-index skips unchanged content.** A source whose content hash matches the stored hash is not embedded again.
   The PHP's `firstOrCreate` never refreshed a URL row.
6. **A ready source stays ready on failure.** A failed re-index records `lastError` and keeps the old chunks and
   status. A source that never became ready is set to `failed` and is not retrieved.
7. **A re-index does not set `indexing` on a ready source.** The status changes only for first indexing. Old chunks
   stay visible until the new ones are written in one transaction. (UNVERIFIED against Postgres.)
8. **Retrieval returns the top `topK` above `minScore`.** The PHP returned the top 5 with no threshold. Ties sort by
   source, then ordinal, then chunk id.
9. **Retrieval is off unless `CHATBOT_KNOWLEDGE_ENABLED` is exactly `true`.** With the flag off, `retrieve` returns
   an empty list and indexing throws `disabled`. Delete still works with the flag off, so clean-up is possible.
10. **Demo guard and credit deduction are not ported.** `Helper::appIsDemo()` and the per-call credit check belong
    to the app shell and the billing layer, not to this port.
11. **Files.** Text, JSON, Markdown and CSV are read as UTF-8. Spreadsheets and PDFs need an injected
    `FileTextExtractor`. If none is given, the upload is refused with `unsupported_content`. The slice ships no
    PDF or spreadsheet library. The PHP used smalot/pdfparser and PhpSpreadsheet.
12. **File and URL sources are de-duplicated by address.** A file is keyed by attachment id. A URL is keyed by the
    final page URL. The PHP keyed URLs the same way.
13. **Articles are read-only inputs.** `importArticles` takes article records from the caller and creates `faq`
    sources with uri `article:<id>`. It never writes the article table. See change request 2.
14. **Q&A.** Stored as `question : answer` (the PHP format) with kind `faq`. The PHP kind was `qa`, which the
    contract does not have.
15. **Errors are redacted and short.** `lastError` is at most 300 characters, and anything shaped like a key
    (`sk-...`, `key_...`, `token-...`) is replaced with `[redacted]`.

## SSRF guard (`ssrf.ts`, `url-source.ts`)

- Only `http:` and `https:`. Only ports 80 and 443. No credentials in the URL.
- Refused host names: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, `*.intranet`, and
  any single-label name.
- IP literals and every resolved address are checked. Blocked ranges: 0/8, 10/8, 100.64/10, 127/8, 169.254/16
  (cloud metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4.
  IPv6: unspecified, loopback, fc00::/7, fe80::/10, fec0::/10, ff00::/8, documentation, Teredo, 6to4 and NAT64 forms
  (checked against the embedded IPv4), and IPv4-mapped addresses. Anything unparseable is blocked.
- Redirects are followed one hop at a time, and every target is checked again. At most 3 hops.
- The fetch uses the injected `HttpClient` with `timeoutMs`. Bodies are capped at 2 MB. Only `text/html` and
  `text/plain` (or no content type) are accepted.
- Crawl: same host only, at most 30 pages, breadth first. Image links, `/cdn-cgi/` paths and fragments are skipped.
  A failed linked page is skipped. A failed start page is an error.

## Not ported (deliberately)

- Vector database or index. Cosine runs in app code over candidate rows, as the contract decided.
- Provider keys, credit checks and usage records. These belong to the `ai/` folder.
- Canned responses and article CRUD.
- PDF and spreadsheet parsing libraries.

## Change requests against `contracts/` (not made)

1. `KnowledgeStorage.replaceChunks`: chunk input has no `id`, but `Embedding.chunkId` must name it. The slice derives
   ids deterministically. The contract should accept the chunk id, or return the ids it created.
2. `KnowledgeStorage` has no read of article records. The article owner should expose a read-only list, or the
   caller should pass records in as this slice does.
3. `HttpRequest` has no redirect option. The contract should say the `HttpClient` must not follow redirects, or
   take `redirect: "manual"`. Without that, the per-hop check in `url-source.ts` is bypassed.
4. Retrieval needs candidate rows (chunk, vector, source title). The contract has no read port for them. This slice
   defines `KnowledgeCandidateReader` in `retriever.ts`. The contract may want to own it.

## Production notes for the owners

- The `HttpClient` that fetches URLs must connect to the address the guard checked, or check again at connect time.
  A name checked by DNS can resolve to a different address when the fetch runs (DNS rebinding).
- The migration draft is `0010_knowledge.sql`. Another agent may use the same number. Renumber at promotion.
- `chatbot_knowledge_embeddings.vector` is jsonb. A large chatbot may need a real vector column later. The
  `Retriever` port is the seam for that.
