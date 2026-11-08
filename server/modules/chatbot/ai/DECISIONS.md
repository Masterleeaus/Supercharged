# AI model providers: decisions

Port of the Commerce Crew model layer (`OpenAIGenerator.php`, `AnthropicGenerator.php`, `GeminiGenerator.php`,
`GeneratorService.php`) to the `ModelProvider` port in `contracts/ai.ts`. Recorded 2026-11-08.

## Files

- `errors.ts`: `ModelCallError`, status-to-code mapping, secret scrubbing.
- `transport.ts`: key handling, input checks, the injected `HttpClient` call, parsing helpers.
- `openai.ts`: primary provider. Chat completions and embeddings.
- `anthropic.ts`: failover provider. Messages API. No embeddings.
- `gemini.ts`: optional provider. Off unless `CHATBOT_GEMINI_ENABLED` is exactly `"true"`.
- `stream.ts`: stream events, built from one completed call.
- `failover.ts`: `completeWithFailover` and `ModelCallFailure`.
- `registry.ts`: `createProviderRegistry`, `createFailoverPolicy`, policy validation.
- `index.ts`: barrel.

## Not ported (belongs to other slices)

- Knowledge base tool, embedding search and web scrape tools. The PHP always offers these to the model. The port
  takes `tools` from the caller. Knowledge slice and runtime own them.
- Ecommerce tool service (`EcommerceToolService`) and its UI replies. Commerce slice owns them.
- Prompt assembly: chatbot instructions, the human-agent tag, the booking-assistant tag, shop prompt, the 1500
  character limit line. Runtime owns prompt building. The port only sends the messages it receives.
- History loading (`ChatbotHistory`, last 10 messages) and image encoding from stored media. Runtime owns both.
- Credit checks and credit deduction (`GeneratorService`). Billing is outside this slice.
- Usage and cost records. No tables are added here. `companyId` and `conversationId` are accepted and carried,
  but nothing is written. Usage storage is a later step.

## Deviations from the PHP

1. OpenAI URL. The PHP posts to `https://api.openai.com//v1/chat/completions` (double slash). The port uses the single-slash URL.
2. Gemini key location. The PHP puts the key in the URL query (`?key=`). The port sends `x-goog-api-key` in a header, so the key cannot appear in a logged or reported URL.
3. Gemini model id. The port checks the id against `[A-Za-z0-9._-]+` before it goes into the path. The PHP does not check.
4. Output cap. The PHP sends no OpenAI token cap. The port sends `max_completion_tokens` only when the caller sets `maxOutputTokens`. Anthropic defaults to 4096, as in the PHP.
5. Timeouts. The PHP uses a fixed 60 seconds per request. The port uses the caller's `timeoutMs` as one budget for the whole call, shared across failover attempts.
6. Retries. The PHP does not retry. The port retries 429, 500, 502, 503 and 504 on the same provider, `maxAttemptsPerProvider` = 2, with backoff from 250 ms doubling to a 2000 ms cap. It does not read `Retry-After`.
7. Timeouts and network failures. These fail over to the next provider at once and are not retried on the same provider, because the budget for that call is already spent.
8. Other errors. 400, 401, 403 and 404 go straight back to the caller with no failover, as the spec requires.
9. Streams. The `HttpClient` returns the whole body as text, so true token streaming is not possible. Streams are built from one completed call and emitted in order. Failover happens before the first event. See change request C2.
10. Gemini off by default. Gemini is listed last in the failover order only when the flag is exactly `"true"`. Otherwise it is absent from the registry.
11. Missing key. The provider is absent from the registry, so failover skips it. A direct call with no key fails with a non-retryable `auth` error that names the variable. A whitespace-only key counts as missing.
12. No key in any message. Error messages are fixed text, plus a scrubbed excerpt (200 characters at most) of the provider's own error text. Known keys and key-shaped strings are replaced with `[redacted]`. Transport error text is not copied at all. The key is held in a private field, so it does not show in JSON or string output.
13. No logging. The PHP logs the Gemini system instruction and ecommerce results. The port logs nothing.
14. Malformed tool arguments. Arguments that are not a JSON object become `{}`. The caller validates tool arguments, as the contract says.
15. Anthropic JSON mode. Anthropic has no native JSON mode here, so the port adds a single instruction to the system prompt when `responseFormat` is `"json"`.
16. Anthropic message shape. Consecutive turns from the same role are merged, as Anthropic requires alternating turns. Empty text messages are dropped.
17. Anthropic embeddings. Not offered by Anthropic. `embed()` fails with `bad_request` and makes no request.
18. Gemini tool results. Gemini `functionResponse` needs a function name, and `ModelMessage` only carries the call id. Tool results are sent as labelled text: `Tool result (<id>): <content>`.
19. Gemini tool calls. The call id is `<name>-<index>`, because Gemini does not return one. A tool call in the response wins over a `STOP` finish reason.
20. Gemini blocked prompt. A prompt blocked with no candidates returns a `content_filter` completion, not an error.
21. Gemini embed usage. Gemini does not return token usage for embeddings, so `inputTokens` is 0.
22. OpenAI embeddings. Vectors are sorted by `index`. A count or length mismatch is an `unknown` error.

## Change requests against contracts/ (not made here)

- C1. `contracts/ai.ts`, `ModelMessage`: add optional `toolCalls?: ModelToolCall[]` for assistant messages. Without it, a multi-turn tool conversation cannot be replayed to OpenAI or Anthropic, because each tool result needs the earlier tool call. This matters for the knowledge and commerce tool loops.
- C2. `contracts/http.ts`: an optional streaming variant of `HttpClient` that yields body chunks. Needed for real token streaming. Optional, since the buffered path works.

## Open question for the owner

- Should usage (tokens per company, per provider, per conversation) be recorded here or in the runtime? Nothing is recorded in this slice.
