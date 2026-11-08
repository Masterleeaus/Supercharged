# NOTICE: chatbot-pwa

These files are copied unchanged from `Clean-Hub/public/chatbot-pwa/` (Clean-Hub source tree, 2026-11-02):

| File | SHA-256 |
| --- | --- |
| apps/index.json | `4b7d2370e985cd2c24145aab343b6893ef8c98bbe99255173adddc36d3a11a9b` |
| apps/titan-train.json | `faa54191347725b28f5ec7bc7e8c122e8854743f1a774e5ce33d222a17455605` |
| apps/titan-train.js | `41fe032a66d9155910ac6318326ec41adbd154e1ab75c812cdcfb0c11ff779df` |

`apps/titan-train.js` sends requests to its own configured base URL with a bearer token. It does not call a model provider.

## Deliberately NOT copied

- `byo-execution-bridge.js`. It is in `Clean-Hub/app/Extensions/Chatbot/public/chatbot-pwa/` and in
  `Clean-Hub/app/Extensions/Chatbot/resources/pwa/chatbot-pwa/`, which differ from each other. Both call
  OpenAI, Anthropic, Gemini, OpenRouter and Ollama directly from the browser using a user-supplied API key.
  That breaks the rule that provider calls stay on the server, so it was excluded.
- The other 52 files in `resources/pwa/chatbot-pwa/`. They are outside the scope of this copy. None of them
  contains a provider host, but they were not reviewed for anything else.
