/*
 * Reply pipeline: takes the latest customer message of a conversation, builds the prompt, calls the model, runs the
 * reply through the existing generative-UI composer (inside recordAssistantReply), and stores the assistant reply.
 *
 * Rules:
 * - Tenancy: the conversation and its chatbot are loaded by companyId. A row that belongs to another company is
 *   treated as absent, so no knowledge, prompt or model call happens for it.
 * - Once only: a customer message gets at most one stored reply. The turn claim is taken before any model call.
 * - Knowledge is retrieved only when CHATBOT_KNOWLEDGE_ENABLED is exactly "true", and only for the company's own chatbot.
 * - No transport, outbox, notification or webhook is used here. Events go to an injected sink.
 */
import { completeWithFailover, isModelProviderError, usableProviders, type CompletionRoute } from "./failover.ts";
import { buildReplyMessages, type PromptComposer } from "./prompt-builder.ts";
import type { ReplyEventSink, ReplyStorage, ReplyTurnStore, ReplyWriter } from "./types.ts";
import type { StreamingRuntime } from "./streaming-runtime.ts";
import type { ChatbotRecord, ConversationRecord, MessageRecord } from "../chatbot-storage.ts";
import {
  CONTRACT_FLAGS,
  readFlag,
  type FlagEnv,
  type ModelMessage,
  type RetrievedChunk,
  type Retriever,
  type RetrievalQuery,
} from "../contracts/index.ts";

export const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_KNOWLEDGE_TOP_K = 5;
const DEFAULT_KNOWLEDGE_MIN_SCORE = 0.2;

export interface ReplyRuntimeDeps {
  storage: ReplyStorage;
  writer: ReplyWriter;
  turns: ReplyTurnStore;
  route: CompletionRoute;
  retriever?: Retriever;
  /** Required with a retriever. Only embeddings made by this model are compared. */
  embeddingModel?: RetrievalQuery["embeddingModel"];
  composer?: PromptComposer;
  /** Used by streamReply. Its persist step is supplied per call by this runtime. */
  streaming?: StreamingRuntime;
  env?: FlagEnv;
  onEvent?: ReplyEventSink;
  now?: () => Date;
}

export interface ReplyOptions {
  /** Hard limit for the model call, in milliseconds. Required. */
  timeoutMs: number;
  surface?: string;
  /** Defaults to "msg:<id of the latest customer message>". */
  turnKey?: string;
  leaseMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  historyLimit?: number;
  knowledgeMaxChars?: number;
  knowledgeTopK?: number;
  knowledgeMinScore?: number;
}

export type ReplyOutcome =
  | { status: "stored"; messageId: string; accepted: boolean }
  | { status: "duplicate"; messageId: string }
  | { status: "in_progress" }
  | { status: "not_found" }
  | { status: "no_customer_message" }
  | { status: "provider_unavailable" }
  | { status: "failed"; reason: string };

export interface ReplyRuntime {
  reply(companyId: string, conversationId: string, options: ReplyOptions): Promise<ReplyOutcome>;
  streamReply(companyId: string, conversationId: string, options: ReplyOptions): Promise<ReplyOutcome>;
}

interface LoadedContext {
  conversation: ConversationRecord;
  chatbot: ChatbotRecord;
  messages: MessageRecord[];
}

export function createReplyRuntime(deps: ReplyRuntimeDeps): ReplyRuntime {
  const env = deps.env ?? {};
  const clock = deps.now ?? (() => new Date());
  const emit = async (event: Parameters<ReplyEventSink>[0]): Promise<void> => {
    try {
      await deps.onEvent?.(event);
    } catch {
      // A sink failure never undoes a stored reply.
    }
  };

  async function loadContext(companyId: string, conversationId: string): Promise<LoadedContext | null> {
    const conversation = await deps.storage.findConversation(companyId, conversationId);
    if (!conversation || conversation.companyId !== companyId || conversation.id !== conversationId) return null;

    const chatbot = await deps.storage.findChatbot(companyId, conversation.chatbotId);
    if (!chatbot || chatbot.companyId !== companyId || chatbot.id !== conversation.chatbotId) return null;

    const stored = await deps.storage.listMessages(companyId, conversationId);
    const messages = stored.filter((message) => message.companyId === companyId && message.conversationId === conversationId);
    return { conversation, chatbot, messages };
  }

  async function retrieve(companyId: string, context: LoadedContext, text: string, options: ReplyOptions): Promise<RetrievedChunk[]> {
    if (!readFlag(CONTRACT_FLAGS.KNOWLEDGE_ENABLED, env) || !deps.retriever || !deps.embeddingModel) return [];
    if (text.trim() === "") return [];
    try {
      return await deps.retriever.retrieve({
        companyId,
        chatbotId: context.chatbot.id,
        text,
        topK: options.knowledgeTopK ?? DEFAULT_KNOWLEDGE_TOP_K,
        minScore: options.knowledgeMinScore ?? DEFAULT_KNOWLEDGE_MIN_SCORE,
        embeddingModel: deps.embeddingModel,
        timeoutMs: options.timeoutMs,
      });
    } catch {
      // Retrieval failure means the reply goes out without reference text. The model is told nothing it cannot verify.
      return [];
    }
  }

  async function storeReply(
    companyId: string,
    conversationId: string,
    turnKey: string,
    text: string,
    surface: string | undefined,
  ): Promise<{ messageId: string; accepted: boolean }> {
    const record = await deps.writer.recordAssistantReply(companyId, conversationId, text, surface);
    const messageId = record.message.id;
    try {
      await deps.turns.complete(companyId, conversationId, turnKey, messageId, clock());
    } catch {
      // The reply is stored. A failed mark means a later retry may see a pending lease, not a second reply.
      await emit({ type: "reply.turn_unmarked", companyId, conversationId, messageId, at: clock() });
    }
    await emit({ type: "reply.stored", companyId, conversationId, messageId, at: clock() });
    return { messageId, accepted: record.accepted };
  }

  async function release(companyId: string, conversationId: string, turnKey: string): Promise<void> {
    try {
      await deps.turns.release(companyId, conversationId, turnKey);
    } catch {
      // The lease expires on its own.
    }
  }

  /** Shared front half: load, find the customer message, take the turn claim. Returns a terminal outcome or a context. */
  async function begin(
    companyId: string,
    conversationId: string,
    options: ReplyOptions,
  ): Promise<{ outcome: ReplyOutcome } | { context: LoadedContext; turnKey: string; customerText: string }> {
    const context = await loadContext(companyId, conversationId);
    if (!context) return { outcome: { status: "not_found" } };

    const lastCustomer = [...context.messages].reverse().find((message) => message.role === "user" && !message.isInternalNote);
    if (!lastCustomer) return { outcome: { status: "no_customer_message" } };

    const turnKey = options.turnKey ?? `msg:${lastCustomer.id}`;
    const claim = await deps.turns.claim(companyId, conversationId, turnKey, clock(), options.leaseMs ?? DEFAULT_LEASE_MS);
    if (claim.kind === "done") {
      await emit({ type: "reply.duplicate", companyId, conversationId, messageId: claim.messageId, at: clock() });
      return { outcome: { status: "duplicate", messageId: claim.messageId } };
    }
    if (claim.kind === "pending") return { outcome: { status: "in_progress" } };

    return { context, turnKey, customerText: lastCustomer.message };
  }

  function promptFor(context: LoadedContext, knowledge: RetrievedChunk[], options: ReplyOptions): ModelMessage[] {
    return buildReplyMessages({
      chatbot: context.chatbot,
      messages: context.messages,
      knowledge,
      composer: deps.composer,
      surface: options.surface,
      historyLimit: options.historyLimit,
      knowledgeMaxChars: options.knowledgeMaxChars,
    });
  }

  async function fail(companyId: string, conversationId: string, turnKey: string, reason: string): Promise<ReplyOutcome> {
    await release(companyId, conversationId, turnKey);
    await emit({ type: "reply.failed", companyId, conversationId, reason, at: clock() });
    return { status: "failed", reason };
  }

  return {
    async reply(companyId, conversationId, options) {
      const begun = await begin(companyId, conversationId, options);
      if ("outcome" in begun) return begun.outcome;
      const { context, turnKey, customerText } = begun;

      try {
        const knowledge = await retrieve(companyId, context, customerText, options);
        const messages = promptFor(context, knowledge, options);
        const result = await completeWithFailover(deps.route, companyId, {
          messages,
          purpose: "reply",
          timeoutMs: options.timeoutMs,
          conversationId,
          temperature: options.temperature,
          maxOutputTokens: options.maxOutputTokens,
        });
        if (!result.ok) {
          await release(companyId, conversationId, turnKey);
          return { status: "provider_unavailable" };
        }

        const text = result.completion.text.trim();
        if (text === "") return fail(companyId, conversationId, turnKey, "empty_reply");

        const stored = await storeReply(companyId, conversationId, turnKey, text, options.surface);
        return { status: "stored", messageId: stored.messageId, accepted: stored.accepted };
      } catch (error) {
        return fail(companyId, conversationId, turnKey, reasonOf(error));
      }
    },

    async streamReply(companyId, conversationId, options) {
      if (!deps.streaming) throw new Error("streamReply needs a StreamingRuntime");
      const begun = await begin(companyId, conversationId, options);
      if ("outcome" in begun) return begun.outcome;
      const { context, turnKey, customerText } = begun;

      try {
        const provider = usableProviders(deps.route)[0];
        if (!provider) {
          await release(companyId, conversationId, turnKey);
          return { status: "provider_unavailable" };
        }

        const knowledge = await retrieve(companyId, context, customerText, options);
        const messages = promptFor(context, knowledge, options);
        const events = provider.stream(companyId, {
          model: deps.route.models[provider.key] as string,
          messages,
          purpose: "reply",
          timeoutMs: options.timeoutMs,
          conversationId,
          temperature: options.temperature,
          maxOutputTokens: options.maxOutputTokens,
        });

        let accepted = false;
        const summary = await deps.streaming.streamReply(companyId, conversationId, events, async (text) => {
          const stored = await storeReply(companyId, conversationId, turnKey, text, options.surface);
          accepted = stored.accepted;
          return stored.messageId;
        });

        if (summary.messageId === "") {
          return fail(companyId, conversationId, turnKey, summary.finishReason === "error" ? "stream_error" : "empty_reply");
        }
        return { status: "stored", messageId: summary.messageId, accepted };
      } catch (error) {
        return fail(companyId, conversationId, turnKey, reasonOf(error));
      }
    },
  };
}

/** Reason codes are safe to log: provider codes and fixed words only. Raw error messages can carry request data. */
function reasonOf(error: unknown): string {
  if (isModelProviderError(error)) return `provider_error:${error.code}`;
  return "internal_error";
}
