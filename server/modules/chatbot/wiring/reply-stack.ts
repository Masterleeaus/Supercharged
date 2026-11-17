/*
 * Composition of the reply path for the widget and the channel webhooks. Builds the real pieces over the Desk database:
 * the conversation store, the chatbot storage read side, the turn claim, the channel outbox, the model route and the
 * reply runtime. Nothing here opens a connection or makes a call: the work happens when a message arrives.
 *
 * Model route: the failover order comes from the provider registry (env keys decide which providers exist). Each
 * provider needs a model id, read from CHATBOT_REPLY_MODEL_OPENAI / _ANTHROPIC / _GEMINI. A provider with no model id is
 * skipped, so with no model configured every reply answers provider_unavailable and nothing is stored.
 *
 * Chatbot for a channel: the company's only active chatbot. With zero or several, no reply is made. Owner decision.
 *
 * Not here: the channel outbox drain. Replies are stored with their send row; the drain that sends them is a worker
 * job and is not started by this module.
 */
import { and, eq } from "drizzle-orm";
import { chatbots } from "../../../../shared/schema.ts";
import { createProviderRegistry, createFailoverPolicy } from "../ai/registry.ts";
import { passThroughLock } from "../cart/keyed-lock.ts";
import { createChannelOutbox } from "../channels/outbox.ts";
import { createDrizzleChannelOutboxStore } from "../channels/outbox-drizzle.ts";
import { systemWebhookResolver } from "../events/ssrf.ts";
import { createPinnedHttpClient } from "../knowledge/pinned-http.ts";
import { createChannelReceiptHandler, buildChannelSend } from "../runtime/channel-receipts.ts";
import { createConversationRuntime } from "../runtime/conversation-runtime.ts";
import { createDrizzleConversationStore } from "../runtime/drizzle-conversation-store.ts";
import { createCustomerTurns } from "../runtime/customer-turn.ts";
import { type CompletionRoute } from "../runtime/failover.ts";
import { createReplyRuntime } from "../runtime/reply-runtime.ts";
import { createConversationReplyStorage } from "../runtime/reply-storage.ts";
import { createConversationReplyWriter } from "../runtime/reply-writer.ts";
import { createDrizzleReplyTurnStore } from "../runtime/turn-store.ts";
import { createWidgetMessagePort } from "../runtime/widget-message-port.ts";
import { createDrizzleChatbotStorage } from "../chatbot-storage.ts";
import { type FlagEnv, type ModelProviderKey, MODEL_PROVIDER_KEYS } from "../contracts/index.ts";
import type { SecretBox } from "../contracts/secrets.ts";
import { DrizzleWidgetStorage } from "../widget/storage.ts";
import type { WidgetMessagePort } from "../widget/handlers.ts";
import type { ChatbotWiringDb } from "./mount.ts";
import type { AcceptedWebhook } from "../channels/inbound-router.ts";

export const REPLY_MODEL_ENV: Readonly<Record<ModelProviderKey, string>> = {
  openai: "CHATBOT_REPLY_MODEL_OPENAI",
  anthropic: "CHATBOT_REPLY_MODEL_ANTHROPIC",
  gemini: "CHATBOT_REPLY_MODEL_GEMINI",
};
const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
/** Largest model response read into memory. Above it the provider call fails. */
const PROVIDER_MAX_BODY_BYTES = 2 * 1024 * 1024;

export function replyModelsFrom(env: FlagEnv): Partial<Record<ModelProviderKey, string>> {
  const models: Partial<Record<ModelProviderKey, string>> = {};
  for (const key of MODEL_PROVIDER_KEYS) {
    const value = env[REPLY_MODEL_ENV[key]]?.trim();
    if (value && MODEL_ID_PATTERN.test(value)) models[key] = value;
  }
  return models;
}

export interface ChatbotReplyStackDeps {
  db: ChatbotWiringDb;
  env: FlagEnv;
  secretBox: SecretBox;
  now?: () => Date;
}

export interface ChatbotReplyStack {
  widget: WidgetMessagePort;
  channels: { onReceipt: (companyId: string, receipt: AcceptedWebhook) => Promise<void> };
}

/** The company's only active chatbot, or null when there are zero or several. */
async function onlyActiveChatbotId(db: ChatbotWiringDb, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ id: chatbots.id })
    .from(chatbots)
    .where(and(eq(chatbots.companyId, companyId), eq(chatbots.active, true)))
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

export function createChatbotReplyStack(deps: ChatbotReplyStackDeps): ChatbotReplyStack {
  const now = deps.now ?? (() => new Date());
  const policy = createFailoverPolicy(deps.env);
  const http = createPinnedHttpClient({ resolve: systemWebhookResolver, maxBodyBytes: PROVIDER_MAX_BODY_BYTES });
  const registry = createProviderRegistry({ env: deps.env, http, policy });
  const route: CompletionRoute = { providers: registry.resolve(policy), models: replyModelsFrom(deps.env), policy };

  const store = createDrizzleConversationStore(deps.db);
  const chatbotStorage = createDrizzleChatbotStorage(deps.db);
  const outbox = createChannelOutbox({ store: createDrizzleChannelOutboxStore(deps.db), clock: now });
  const writer = createConversationReplyWriter({
    store,
    channelOutbox: outbox,
    buildSend: buildChannelSend,
    // Database deployment: the row locks in the reply transaction carry the guarantee across processes.
    lock: passThroughLock,
    now,
  });
  const replies = createReplyRuntime({
    storage: createConversationReplyStorage({ store, chatbots: chatbotStorage }),
    writer,
    turns: createDrizzleReplyTurnStore(deps.db),
    route,
    env: deps.env,
    now,
  });
  const conversations = createConversationRuntime({ store, route, now });
  const turns = createCustomerTurns({ store, conversations, replies, now });

  const widget = createWidgetMessagePort({
    chatbots: new DrizzleWidgetStorage(deps.db, deps.secretBox),
    turns,
    store,
  });
  const receipts = createChannelReceiptHandler({
    turns,
    chatbotIdFor: (companyId) => onlyActiveChatbotId(deps.db, companyId),
  });

  return { widget, channels: { onReceipt: receipts } };
}
