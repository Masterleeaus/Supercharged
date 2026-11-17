// Deterministic fixtures for the voice-to-booking sandbox (issue #338).
// Contract version: voice-to-booking-sandbox/0.1.0
//
// REAL code under test: VoiceCallService, MemoryCallProvider (mocked carrier), MemoryVoiceCallStorage,
// and the HMAC webhook policy in server/modules/chatbot/voice-call/policy.ts.
// FIXTURE code (not product code): the mock calendar, the consent ledger and the booking gate in
// createSandbox(). They model the contract the booking path must follow; they do not prove that
// Scheduled availability, Sorted or Central behave this way. No network, no clock other than the injected one.

import { VoiceCallService } from "../../server/modules/chatbot/voice-call/service.ts";
import { MemoryCallProvider, signMemoryWebhook } from "../../server/modules/chatbot/voice-call/provider-memory.ts";
import { MemoryVoiceCallStorage } from "../../server/modules/chatbot/voice-call/storage-memory.ts";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";

export const FIXTURE_CONTRACT_VERSION = "voice-to-booking-sandbox/0.1.0";

export const COMPANY_A = "11111111-1111-4111-8111-111111111111";
export const COMPANY_B = "22222222-2222-4222-8222-222222222222";
export const CHATBOT_A = "chatbot-a";
export const CHATBOT_B = "chatbot-b";
export const SECRET_A = "fixture-secret-company-a";
export const SECRET_B = "fixture-secret-company-b";
export const CALLER_1 = "+61412345678";
export const CALLER_2 = "+61498765432";
export const AGENT_NUMBER = "+61298765432";
export const SLOT_RESOURCE = "crew-1";
export const SLOT_START = "2026-11-20T09:00:00.000Z";
export const T0 = new Date("2026-11-17T10:00:00.000Z");

const ENV_ON = { [CONTRACT_FLAGS.VOICE_ENABLED]: "true" };

/** Digits only, so "+61 412 345 678" and "+61412345678" are the same caller in the consent ledger. */
export function callerKey(number) {
  return String(number).replace(/\D/g, "");
}

/**
 * Mock carrier. Builds a signed webhook exactly as a provider would send it (Unix-seconds timestamp, HMAC body).
 * events: [{ type, providerCallId, text?, at? }]
 */
export function carrierWebhook(secret, events, at = T0) {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const body = events.map((e) => ({
    type: e.type,
    providerCallId: e.providerCallId,
    occurredAt: (e.at ?? at).toISOString(),
    ...(e.text !== undefined ? { text: e.text } : {}),
  }));
  return signMemoryWebhook({ secret, timestamp, events: body });
}

/** Mock calendar. Each company has its own calendar. A slot a company does not own cannot be held by it. */
export function createMockCalendar() {
  const calendars = new Map(); // companyId -> { slots: Map<key, {startIso,resource}>, holds: Map, bookings: Map }

  const calendarFor = (companyId) => {
    if (!calendars.has(companyId)) calendars.set(companyId, { slots: new Map(), holds: new Map(), bookings: new Map() });
    return calendars.get(companyId);
  };
  const slotKey = (resource, startIso) => `${resource}@${startIso}`;

  return {
    seedSlot(companyId, resource, startIso) {
      calendarFor(companyId).slots.set(slotKey(resource, startIso), { resource, startIso });
    },
    /** Places a hold on a slot for one call. Refuses a slot the company does not own, or one already held or booked. */
    hold({ companyId, callId, resource, startIso, holdId }) {
      const cal = calendarFor(companyId);
      const key = slotKey(resource, startIso);
      if (!cal.slots.has(key)) return { ok: false, reason: "no_slot" };
      const taken = [...cal.holds.values()].some((h) => h.key === key && !h.released);
      const booked = cal.bookings.has(key);
      if (taken || booked) return { ok: false, reason: "slot_taken" };
      cal.holds.set(holdId, { holdId, key, callId, released: false });
      return { ok: true, holdId };
    },
    /** Turns a hold into a booking. Only the call that placed the hold may commit it, and only while it is live. */
    commit({ companyId, callId, holdId }) {
      const cal = calendarFor(companyId);
      const hold = cal.holds.get(holdId);
      if (!hold || hold.released) return { ok: false, reason: "no_hold" };
      if (hold.callId !== callId) return { ok: false, reason: "hold_belongs_to_other_call" };
      cal.bookings.set(hold.key, { holdId, callId });
      cal.holds.delete(holdId);
      return { ok: true, bookingKey: hold.key };
    },
    /** Frees the holds of one call (used when the call is interrupted). Returns how many were released. */
    releaseForCall({ companyId, callId }) {
      const cal = calendarFor(companyId);
      let released = 0;
      for (const hold of cal.holds.values()) {
        if (hold.callId === callId && !hold.released) {
          hold.released = true;
          released += 1;
        }
      }
      for (const [id, hold] of cal.holds) if (hold.released) cal.holds.delete(id);
      return released;
    },
    bookings(companyId) {
      return [...calendarFor(companyId).bookings.keys()];
    },
    holdCount(companyId) {
      return calendarFor(companyId).holds.size;
    },
  };
}

/** Consent ledger. Denied by default. Keyed by company and caller digits. */
export function createConsentLedger() {
  const granted = new Set();
  return {
    grant(companyId, number) {
      granted.add(`${companyId}|${callerKey(number)}`);
    },
    revoke(companyId, number) {
      granted.delete(`${companyId}|${callerKey(number)}`);
    },
    isGranted(companyId, number) {
      return granted.has(`${companyId}|${callerKey(number)}`);
    },
  };
}

/**
 * Builds the voice service on the real memory provider and storage, plus the fixture calendar, consent ledger and
 * booking gate. The booking gate reads only structured arguments and the stored call row. It never reads transcript text.
 */
export function createSandbox({ clockStart = T0 } = {}) {
  const clock = { now: clockStart };
  const logs = [];
  const logger = {
    info: (message, fields) => logs.push({ level: "info", message, fields }),
    warn: (message, fields) => logs.push({ level: "warn", message, fields }),
  };
  const storage = new MemoryVoiceCallStorage();
  const provider = new MemoryCallProvider({ key: "mock-carrier" });
  const chatbots = new Set([`${COMPANY_A}|${CHATBOT_A}`, `${COMPANY_B}|${CHATBOT_B}`]);
  const credentials = new Map([
    [`${COMPANY_A}|${CHATBOT_A}`, { secret: SECRET_A }],
    [`${COMPANY_B}|${CHATBOT_B}`, { secret: SECRET_B }],
  ]);
  const http = async () => {
    throw new Error("network must not be reached in the sandbox");
  };
  const voice = new VoiceCallService({
    storage,
    provider,
    http,
    quota: { secondsLimitFor: async () => -1 },
    chatbots: { exists: async (c, b) => chatbots.has(`${c}|${b}`) },
    credentials: { load: async (c, b) => credentials.get(`${c}|${b}`) ?? null },
    credits: { hasBalance: async () => true, chargeTranscript: async () => undefined },
    logger,
    env: ENV_ON,
    callbackHosts: [],
    clock: () => clock.now,
  });

  const calendar = createMockCalendar();
  const consent = createConsentLedger();
  const sandbox = { voice, storage, provider, calendar, consent, logs, clock };

  /** Delivers a signed carrier webhook. Releases the holds of any call that ends in this delivery. */
  sandbox.deliver = async (companyId, chatbotId, events, at = clock.now) => {
    const secret = credentials.get(`${companyId}|${chatbotId}`)?.secret ?? "unknown-secret";
    const result = await voice.handleWebhook(companyId, chatbotId, carrierWebhook(secret, events, at));
    for (const e of events) {
      if (e.type !== "failed" && e.type !== "completed") continue;
      const call = await storage.findByProviderCallId(companyId, provider.key, e.providerCallId);
      if (call) calendar.releaseForCall({ companyId, callId: call.id });
    }
    return result;
  };

  /** Records an inbound call from the carrier. Returns the service result (ok with the call session). */
  sandbox.inbound = async (companyId, chatbotId, providerCallId, fromNumber) => {
    const secret = credentials.get(`${companyId}|${chatbotId}`)?.secret ?? "unknown-secret";
    const webhook = carrierWebhook(secret, [{ type: "ringing", providerCallId }]);
    return voice.startInbound(companyId, chatbotId, webhook, {
      providerCallId,
      fromNumber,
      toNumber: AGENT_NUMBER,
    });
  };

  /** Booking gate. Refuses unless the call is live for this company and chatbot, and the caller has consented. */
  sandbox.requestHold = async ({ companyId, chatbotId, callId, caller, holdId, resource = SLOT_RESOURCE, startIso = SLOT_START }) => {
    const call = await storage.findById(companyId, chatbotId, callId);
    if (!call) return { ok: false, reason: "unknown_call" };
    if (call.status !== "in_progress") return { ok: false, reason: "call_not_live" };
    if (!consent.isGranted(companyId, caller)) return { ok: false, reason: "consent_required" };
    return calendar.hold({ companyId, callId, resource, startIso, holdId });
  };

  /** Commits a hold for a call that is still live. */
  sandbox.commitHold = async ({ companyId, chatbotId, callId, holdId }) => {
    const call = await storage.findById(companyId, chatbotId, callId);
    if (!call) return { ok: false, reason: "unknown_call" };
    if (call.status !== "in_progress") return { ok: false, reason: "call_not_live" };
    return calendar.commit({ companyId, callId, holdId });
  };

  return sandbox;
}
