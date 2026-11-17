/**
 * Boot-time construction of the chatbot background workers. The server calls startChatbotWorkersFromEnv once, after
 * the chatbot module is mounted. Nothing here is built unless its flag is exactly "true":
 *
 *   CHATBOT_WORKERS_ENABLED            the runner. Off means no service is built and no timer starts.
 *   CHATBOT_OUTBOUND_WEBHOOKS_ENABLED  the event outbox drain (webhook dispatch). Off means it is not passed in.
 *   CHATBOT_REMINDERS_ENABLED          the appointment reminder pipeline (booking-providers/reminder-pipeline.ts).
 *                                      Built only when this is "true" and the workers flag is on, because the reminders
 *                                      job runs inside the workers runner.
 *
 * Services built here use the existing Drizzle adapters and the existing factories only. No business logic lives here.
 *
 * Not built here (blocked, see the report that added this file):
 * VoiceCallService (voice-call/service.ts) IS constructed when CHATBOT_WORKERS_ENABLED is "true", so the voice_call_limits
 * job runs. It has no production CallProvider and no CreditLedger yet (owner decisions), so it is built with the
 * fail-closed ports in voice-call/unconfigured.ts: no call can start, and the quota sweep only ends calls already in
 * progress past their cap. The sweep is not gated by the voice flag (see voice-call/DECISIONS.md).
 * - voice_sweep (VoiceSweepService) and booking_reconcile are not part of this change.
 */
import { randomUUID } from "node:crypto";
import { CONTRACT_FLAGS, readFlag, type FlagEnv } from "../contracts/flags.ts";
import type { SecretBox } from "../contracts/secrets.ts";
import { createDrizzleEventsStore, type EventsExecutor } from "../events/drizzle-store.ts";
import { createOutboxProcessor } from "../events/outbox.ts";
import { createStructuredActionService } from "../events/structured-actions.ts";
import type { EventsDeps } from "../events/types.ts";
import { createOutboxStorage } from "../events/outbox.ts";
import { createWebhookDispatcher } from "../events/webhooks.ts";
import { systemWebhookResolver } from "../events/ssrf.ts";
import { createPinnedHttpClient } from "../knowledge/pinned-http.ts";
import { createEmailServiceSender } from "../../comms/email-provider-adapter.ts";
import type { EmailSender } from "../../comms/email-send-transport.ts";
import { createBookingService } from "../bookings/booking-service.ts";
import { createDrizzleBookingStorage } from "../bookings/drizzle-booking-storage.ts";
import { isBookingsEnabled } from "../bookings/flags.ts";
import type { ReminderChannel } from "../bookings/types.ts";
import type { ReminderSender } from "../contracts/index.ts";
import { createChannelCredentialSource } from "../channels/credentials.ts";
import { createChannelOutbox, type ChannelOutbox } from "../channels/outbox.ts";
import { createDrizzleChannelOutboxStore, type OutboxDb } from "../channels/outbox-drizzle.ts";
import type { ChannelRegistry, OutboundPipelineDeps } from "../channels/framework.ts";
import { createDrizzleChannelAccountStorage, type ChannelDb } from "../channels/drizzle-storage.ts";
import { createDrizzleProviderStore, type BookingProvidersDb } from "../booking-providers/drizzle-store.ts";
import { createDrizzleAttemptLog } from "../booking-providers/reminder-attempt-log.ts";
import { createReminderPipeline } from "../booking-providers/reminder-pipeline.ts";
import {
  createEmailReminderSender,
  createNotWiredReminderSender,
  createWhatsappReminderSender,
  type ReminderEmailSend,
} from "../booking-providers/reminder-senders.ts";
import { createSseHub } from "../realtime/hub.ts";
import { DrizzleVoiceCallStorage, type VoiceCallPgDatabase } from "../voice-call/storage-drizzle.ts";
import { VoiceCallService, type VoiceCallDeps } from "../voice-call/service.ts";
import {
  UnconfiguredCallProvider,
  unconfiguredChatbotGate,
  unconfiguredCredentials,
  unconfiguredCredits,
  unconfiguredQuota,
} from "../voice-call/unconfigured.ts";
import { createSsePublisher } from "../realtime/sse-publisher.ts";
import {
  CHATBOT_WORKERS_FLAG,
  startChatbotWorkers,
  type ChatbotWorkerDb,
  type ChatbotWorkerServices,
  type ChatbotWorkersHandle,
  type WorkerLogger,
} from "./run.ts";

/** Channel webhooks and the channel send drain. Off means no channel outbox service is built. */
export const CHANNELS_FLAG = "CHATBOT_CHANNELS_ENABLED";

export interface ChatbotBootDeps {
  /** Desk database handle (db in server/db.ts). */
  db: ChatbotWorkerDb & EventsExecutor;
  /** process.env in production. */
  env: FlagEnv;
  /** Required only when CHATBOT_OUTBOUND_WEBHOOKS_ENABLED or CHATBOT_CHANNELS_ENABLED is "true". Built by the caller from the secrets module. */
  secretBox?: SecretBox;
  /**
   * Channel providers the send drain sends through. Used only when CHATBOT_CHANNELS_ENABLED is "true". When it is
   * missing or has no provider registered, the channel send drain is not started (logged once at boot).
   */
  channelRegistry?: ChannelRegistry;
  logger?: WorkerLogger;
  clock?: () => Date;
  /** Passed from mountChatbotModule(...).voiceCall. Only the demo cap options are read. */
  voiceCall?: { demoMode: boolean; demoSecondsLimit?: number };
}

/**
 * Builds the services the workers need, one by one, each only when its flag is on. Returns an empty object when
 * CHATBOT_WORKERS_ENABLED is off, so no adapter is constructed at all.
 */
export function buildChatbotWorkerServices(deps: ChatbotBootDeps): ChatbotWorkerServices {
  const services: ChatbotWorkerServices = {};
  if (!readFlag(CHATBOT_WORKERS_FLAG, deps.env)) return services;

  const clock = deps.clock ?? (() => new Date());
  const events: EventsDeps = { now: clock, newId: () => randomUUID() };
  const store = createDrizzleEventsStore(deps.db);

  // Expiry sweep: stale "proposed" structured actions are set to "expired" once per company per events_worker tick.
  services.structuredActions = createStructuredActionService(store, events);

  // Webhook dispatch: the outbox drain calls the dispatcher. The dispatcher uses the pinned HTTP client (no custom
  // http is passed). Realtime publish has no stream route mounted yet, so events go to a hub with no subscribers.
  if (readFlag(CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED, deps.env)) {
    if (!deps.secretBox) {
      throw new Error(`${CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED} is "true" but no secretBox was supplied. Refusing to start.`);
    }
    const webhooks = createWebhookDispatcher({ secretBox: deps.secretBox, store, env: deps.env, events });
    const publisher = createSsePublisher(createSseHub());
    services.eventOutbox = { processor: createOutboxProcessor({ store, webhooks, publisher, events }) };
  }

  // Voice-call service for the quota sweep. Fail-closed ports until a provider and a ledger exist, so no call can start.
  services.voiceCallLimits = buildVoiceCallService(deps, clock);

  // Appointment reminders. Off unless CHATBOT_REMINDERS_ENABLED is exactly "true".
  if (readFlag(CONTRACT_FLAGS.REMINDERS_ENABLED, deps.env)) {
    services.reminders = buildReminderService(deps, store, events, clock);
  }

  // Channel send drain. Off unless CHATBOT_CHANNELS_ENABLED is exactly "true".
  if (readFlag(CHANNELS_FLAG, deps.env)) {
    const channelOutbox = buildChannelOutboxService(deps, clock);
    if (channelOutbox) services.channelOutbox = channelOutbox;
    else deps.logger?.info("workers.channel_send_no_providers", { flag: CHANNELS_FLAG });
  }

  return services;
}

/**
 * Builds the channel send drain over the existing outbox store, credential source and pinned HTTP client. Returns
 * undefined when no provider is registered: the drain would only fail every queued row, so it is not started.
 * Refuses to build when no secret box was supplied, because credentials cannot be opened without it.
 */
export function buildChannelOutboxService(
  deps: ChatbotBootDeps,
  clock: () => Date,
): { outbox: ChannelOutbox; pipeline: OutboundPipelineDeps } | undefined {
  if (!deps.secretBox) {
    throw new Error(`${CHANNELS_FLAG} is "true" but no secretBox was supplied. Refusing to start.`);
  }
  const registry = deps.channelRegistry;
  if (!registry || registry.kinds().length === 0) return undefined;

  const outbox = createChannelOutbox({
    store: createDrizzleChannelOutboxStore(deps.db as unknown as OutboxDb),
    clock,
  });
  const pipeline: OutboundPipelineDeps = {
    registry,
    credentials: createChannelCredentialSource({
      storage: createDrizzleChannelAccountStorage(deps.db as unknown as ChannelDb, clock),
      secretBox: deps.secretBox,
    }),
    http: createPinnedHttpClient({ resolve: systemWebhookResolver, maxBodyBytes: 65536 }),
  };
  return { outbox, pipeline };
}

/**
 * Builds the voice-call service with the fail-closed ports. Storage is the existing Drizzle adapter. Nothing here runs a
 * query at construction time.
 */
export function buildVoiceCallService(deps: ChatbotBootDeps, clock: () => Date): VoiceCallService {
  const logger = deps.logger ?? { info() {}, warn() {} };
  const voiceDeps: VoiceCallDeps = {
    storage: new DrizzleVoiceCallStorage(deps.db as unknown as VoiceCallPgDatabase),
    provider: new UnconfiguredCallProvider(),
    http: createPinnedHttpClient({ resolve: systemWebhookResolver, maxBodyBytes: 65536 }),
    quota: unconfiguredQuota,
    chatbots: unconfiguredChatbotGate,
    credentials: unconfiguredCredentials,
    credits: unconfiguredCredits,
    logger,
    env: deps.env,
    // No status-callback host is allowed until the provider is chosen. Empty means every callback URL is refused.
    callbackHosts: [],
    clock,
    demoMode: deps.voiceCall?.demoMode ?? false,
    demoSecondsLimit: deps.voiceCall?.demoSecondsLimit,
  };
  return new VoiceCallService(voiceDeps);
}

/** Channels the reminder job sends on at boot. Only email has a transport wired to a real recipient rule today. */
export const REMINDER_BOOT_CHANNELS: ReminderChannel[] = ["email"];
/** How long before the appointment the reminder goes out. */
export const REMINDER_BOOT_LEAD_MINUTES = 24 * 60;

/** Email is sent through the existing EmailService. It is imported on the first send, not at boot. */
function lazyEmailSend(): ReminderEmailSend {
  let sender: Promise<EmailSender> | undefined;
  return async (message) => {
    try {
      sender ??= createEmailServiceSender();
      return await (await sender)(message);
    } catch (err) {
      sender = undefined;
      throw err;
    }
  };
}

/**
 * Builds the reminder pipeline from the existing adapters. Email is wired. WhatsApp has its adapter, but no company
 * to channel-account lookup exists, so it fails with account_not_wired and is not in REMINDER_BOOT_CHANNELS. SMS and
 * the other channels have no transport, and their senders fail with not_wired.
 */
function buildReminderService(
  deps: ChatbotBootDeps,
  store: ReturnType<typeof createDrizzleEventsStore>,
  events: EventsDeps,
  clock: () => Date,
) {
  const bookingsDb = deps.db as unknown as Parameters<typeof createDrizzleBookingStorage>[0]["db"];
  const providerDb = deps.db as unknown as BookingProvidersDb;
  const bookings = createBookingService({
    storage: createDrizzleBookingStorage({ db: bookingsDb, secretBox: deps.secretBox as unknown as Parameters<typeof createDrizzleBookingStorage>[0]["secretBox"], now: clock }),
    now: clock,
    enabled: isBookingsEnabled(deps.env),
  });

  const senders: Partial<Record<ReminderChannel, ReminderSender>> = {
    email: createEmailReminderSender(lazyEmailSend()),
    sms: createNotWiredReminderSender("sms"),
  };
  if (deps.secretBox) {
    const credentials = createChannelCredentialSource({
      storage: createDrizzleChannelAccountStorage(deps.db as unknown as ChannelDb, clock),
      secretBox: deps.secretBox,
    });
    senders.whatsapp = createWhatsappReminderSender({ resolveAccountId: () => null, credentials });
  }

  return createReminderPipeline({
    bookings,
    ledger: createDrizzleProviderStore(providerDb).ledger,
    attemptLog: createDrizzleAttemptLog(providerDb),
    senders,
    outbox: createOutboxStorage(store, events),
    http: createPinnedHttpClient({ resolve: systemWebhookResolver, maxBodyBytes: 65536 }),
    config: { channels: REMINDER_BOOT_CHANNELS, leadMinutes: REMINDER_BOOT_LEAD_MINUTES },
    now: clock,
  });
}

/**
 * Builds the services and starts the workers. With CHATBOT_WORKERS_ENABLED off this returns the no-op handle that
 * startChatbotWorkers returns, and builds nothing.
 */
export function startChatbotWorkersFromEnv(deps: ChatbotBootDeps): ChatbotWorkersHandle {
  const services = buildChatbotWorkerServices(deps);
  return startChatbotWorkers({
    db: deps.db,
    env: deps.env,
    services,
    logger: deps.logger,
    clock: deps.clock,
  });
}
