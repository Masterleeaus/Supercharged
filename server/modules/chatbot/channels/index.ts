/**
 * Channel folder public surface. Other channel builders import the framework from here.
 *
 * framework.ts holds the registry, the inbound pipeline and the outbound path. The registry keys providers by
 * ChannelKind and refuses anything else. Shared types come from ../contracts/index.ts, not from this folder.
 */
export {
  answerChallenge,
  isChallengeCapable,
  CHANNEL_HTTP_TIMEOUT_MS,
  ChannelRegistryError,
  checkParseResults,
  constantTimeEqual,
  createChannelRegistry,
  formFields,
  isChannelKind,
  parseFormEntries,
  receiveWebhook,
  redactSecrets,
  sendOutbound,
  truncateProviderText,
  verificationFailureReason,
  verificationPassed,
  type ChallengeCapableProvider,
  type ChallengeResponse,
  type ChannelRegistry,
  type ChannelRegistryErrorCode,
  type VerificationFailure,
  type VerificationReason,
  type WebhookPipelineDeps,
  type WebhookReceipt,
  type WebhookRejectReason,
  type OutboundPipelineDeps,
} from "./framework.ts";
export {
  ChannelCredentialError,
  createChannelCredentialSource,
  MAX_CREDENTIAL_VALUE_LENGTH,
  saveChannelCredentials,
  validateCredentials,
  type ChannelAccountStorage,
  type CredentialStoreDeps,
} from "./credentials.ts";
export { createMemoryChannelAccountStorage } from "./memory-storage.ts";
export {
  buildFindSealedQuery,
  buildSaveSealedQuery,
  createDrizzleChannelAccountStorage,
  type ChannelDb,
} from "./drizzle-storage.ts";
export { chatbotChannelAccounts, chatbotChannelSendKeys, chatbotChannelOutbox } from "../db/channels-core.ts";
export * from "./whatsapp/index.ts";
export {
  createChannelOutbox,
  createMemoryChannelOutboxStore,
  backoffMs,
  toOutboundMessage,
  validateOutboundForEnqueue,
  OUTBOX_DEFAULTS,
  OUTBOX_STATUSES,
  type ChannelOutbox,
  type ChannelOutboxRow,
  type ChannelOutboxStatus,
  type ChannelOutboxStore,
  type DrainSummary,
  type OutboxTx,
} from "./outbox.ts";
export { createDrizzleChannelOutboxStore, type OutboxDb } from "./outbox-drizzle.ts";
export {
  handleChallengeGet,
  handleInboundPost,
  webhookBodyParser,
  type AcceptedWebhook,
  type InboundRouterDeps,
} from "./inbound-router.ts";
export { createWhatsappWebhookRouter, type WhatsappRouterDeps } from "./whatsapp/router.ts";
export { createTelegramWebhookRouter } from "./telegram/router.ts";
export { createMessengerWebhookRouter } from "./messenger/router.ts";
export { createInstagramWebhookRouter } from "./instagram/router.ts";
export { createTelegramProvider, createTelegramStore, TELEGRAM_ACCOUNT_HEADER } from "./telegram/index.ts";
export { createMessengerProvider, createMessengerStore } from "./messenger/index.ts";
export { createInstagramProvider, computeSignatureHeader, answerSubscriptionChallenge } from "./instagram/index.ts";
