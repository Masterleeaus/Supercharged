/**
 * Stream events for the ModelProvider port.
 * The injected HttpClient returns the whole body as text, so true token streaming is not possible yet.
 * Streams are therefore built from one completed call. Events are emitted in order after the call succeeds.
 * Failover happens before the first event, which satisfies failoverAfterFirstDelta: false.
 */
import type {
  FailoverPolicy,
  ModelCompletion,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ProviderRegistry,
} from "../contracts/index.ts";
import { toProviderError } from "./errors.ts";
import { ModelCallFailure, completeWithFailover } from "./failover.ts";
import type { FailoverOptions } from "./failover.ts";

export function eventsFromCompletion(completion: ModelCompletion): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [];
  if (completion.text !== "") events.push({ type: "text-delta", text: completion.text });
  for (const call of completion.toolCalls) events.push({ type: "tool-call", call });
  events.push({ type: "usage", usage: completion.usage });
  events.push({ type: "done", finishReason: completion.finishReason });
  return events;
}

/** Stream for a single provider. Errors become an "error" event, not a throw. */
export async function* bufferedStream(
  provider: ModelProvider,
  companyId: string,
  request: ModelRequest,
): AsyncGenerator<ModelStreamEvent> {
  let completion: ModelCompletion;
  try {
    completion = await provider.complete(companyId, request);
  } catch (err) {
    yield { type: "error", error: toProviderError(err, provider.key) };
    return;
  }
  for (const event of eventsFromCompletion(completion)) yield event;
}

/** Stream across providers, using the same failover rules as completeWithFailover. */
export async function* streamWithFailover(
  registry: ProviderRegistry,
  policy: FailoverPolicy,
  companyId: string,
  request: ModelRequest,
  options: FailoverOptions = {},
): AsyncGenerator<ModelStreamEvent> {
  let completion: ModelCompletion;
  try {
    completion = await completeWithFailover(registry, policy, companyId, request, options);
  } catch (err) {
    const error = err instanceof ModelCallFailure ? err.error : toProviderError(err, policy.order[0] ?? "openai");
    yield { type: "error", error };
    return;
  }
  for (const event of eventsFromCompletion(completion)) yield event;
}
