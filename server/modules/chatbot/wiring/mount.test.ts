import { test } from "node:test";
import assert from "node:assert/strict";
import type { Express, RequestHandler } from "express";
import {
  mountChatbotModule,
  resolveHasHumanAgents,
  WIRING_FLAGS,
  WIRING_PREFIXES,
  type ChatbotWiringDeps,
} from "./mount.ts";
import type { SecretBox } from "../contracts/secrets.ts";
import type { ChannelRegistry } from "../channels/framework.ts";

type UseCall = unknown[];

function fakeApp() {
  const calls: UseCall[] = [];
  const app = {
    use: (...args: unknown[]) => {
      calls.push(args);
      return app;
    },
  };
  return { app: app as unknown as Pick<Express, "use">, calls };
}

const passthrough: RequestHandler = (_req, _res, next) => next();

const fakeSecretBox = {
  encrypt: async () => ({ ciphertext: "x", iv: "x", tag: "x" }),
  decrypt: async () => "",
} as unknown as SecretBox;

function deps(env: Record<string, string | undefined>): ChatbotWiringDeps {
  return {
    // Storage factories only hold the handle until a query runs, so a stub is enough for mount tests.
    db: {} as ChatbotWiringDeps["db"],
    env,
    authenticate: passthrough,
    requireCompanyScope: passthrough,
    requireRole: () => passthrough,
    secretBox: fakeSecretBox,
    widget: {
      messages: { send: async () => ({ id: "m1", text: "" }) },
      assetBaseUrl: "https://assets.example.test",
    },
    channels: {
      onReceipt: async () => {},
    },
    clock: () => new Date("2026-11-09T00:00:00Z"),
  };
}

/** Prefixes recorded by app.use: the first argument of each call, when it is a string. */
function prefixesOf(calls: UseCall[]): string[] {
  return calls.map((args) => args[0]).filter((x): x is string => typeof x === "string");
}

const ALL_FLAGS = Object.values(WIRING_FLAGS);

// Telegram has its own flag (CHATBOT_TELEGRAM_CHANNEL_ENABLED), so it is not mounted with CHATBOT_CHANNELS_ENABLED alone.
const TELEGRAM_PREFIX = `${WIRING_PREFIXES.channels}/:companyId/telegram`;
const CHANNEL_PREFIXES = [
  `${WIRING_PREFIXES.channels}/:companyId/whatsapp`,
  `${WIRING_PREFIXES.channels}/:companyId/messenger`,
  `${WIRING_PREFIXES.channels}/:companyId/instagram`,
];

const PREFIX_FOR_FLAG: Record<string, string[]> = {
  [WIRING_FLAGS.BUILDER]: [WIRING_PREFIXES.builder],
  [WIRING_FLAGS.AGENT]: [WIRING_PREFIXES.agent],
  [WIRING_FLAGS.BOOKINGS]: [WIRING_PREFIXES.bookings],
  [WIRING_FLAGS.CONTENT]: [WIRING_PREFIXES.content],
  [WIRING_FLAGS.WIDGET]: [WIRING_PREFIXES.widget],
  [WIRING_FLAGS.CHANNELS]: CHANNEL_PREFIXES,
};

test("with every flag off, nothing is mounted", () => {
  const { app, calls } = fakeApp();
  const result = mountChatbotModule(app, deps({}));
  assert.equal(calls.length, 0);
  assert.deepEqual(result.mounted, []);
  assert.deepEqual(result.routers, {});
});

test("each flag mounts only its own prefix", () => {
  for (const flag of ALL_FLAGS) {
    const { app, calls } = fakeApp();
    const result = mountChatbotModule(app, deps({ [flag]: "true" }));
    assert.deepEqual(prefixesOf(calls), PREFIX_FOR_FLAG[flag], `flag ${flag}`);
    assert.deepEqual(result.mounted, PREFIX_FOR_FLAG[flag], `flag ${flag} report`);
  }
});

test("telegram mounts only when its own flag is also exactly true", () => {
  const tgFlag = "CHATBOT_TELEGRAM_CHANNEL_ENABLED";
  const channelsOn = { [WIRING_FLAGS.CHANNELS]: "true" };

  const withoutTelegram = fakeApp();
  const r1 = mountChatbotModule(withoutTelegram.app, deps(channelsOn));
  assert.ok(!r1.mounted.includes(TELEGRAM_PREFIX));
  assert.equal(r1.routers.channels?.telegram, undefined);

  for (const value of ["TRUE", "1", "yes", ""]) {
    const off = fakeApp();
    const r = mountChatbotModule(off.app, deps({ ...channelsOn, [tgFlag]: value }));
    assert.ok(!r.mounted.includes(TELEGRAM_PREFIX), `telegram flag ${JSON.stringify(value)} must not mount`);
  }

  const withTelegram = fakeApp();
  const r2 = mountChatbotModule(withTelegram.app, deps({ ...channelsOn, [tgFlag]: "true" }));
  assert.ok(r2.mounted.includes(TELEGRAM_PREFIX));
  assert.ok(r2.routers.channels?.telegram);

  const telegramOnly = fakeApp();
  const r3 = mountChatbotModule(telegramOnly.app, deps({ [tgFlag]: "true" }));
  assert.deepEqual(r3.mounted, []);
});

test("only the exact string true turns a flag on", () => {
  for (const value of ["TRUE", "True", "1", "yes", "on", " true", "true ", ""]) {
    for (const flag of ALL_FLAGS) {
      const { app, calls } = fakeApp();
      const result = mountChatbotModule(app, deps({ [flag]: value }));
      assert.equal(calls.length, 0, `flag ${flag}=${JSON.stringify(value)} must not mount`);
      assert.deepEqual(result.mounted, []);
    }
  }
});

test("a flag that is on without its required dependency refuses to mount", () => {
  const { app } = fakeApp();
  const missingSecret = { ...deps({ [WIRING_FLAGS.BOOKINGS]: "true" }), secretBox: undefined };
  assert.throws(() => mountChatbotModule(app, missingSecret), /CHATBOT_BOOKINGS_ENABLED.*secretBox/);

  const missingWidget = { ...deps({ [WIRING_FLAGS.WIDGET]: "true" }), widget: undefined };
  assert.throws(() => mountChatbotModule(app, missingWidget), /CHATBOT_WIDGET_ENABLED.*messages port/);
});

test("the surfaces that are on are returned as routers, and the others are absent", () => {
  const { app } = fakeApp();
  const result = mountChatbotModule(app, deps({ [WIRING_FLAGS.BUILDER]: "true", [WIRING_FLAGS.CONTENT]: "true" }));
  assert.ok(result.routers.builder);
  assert.ok(result.routers.content);
  assert.equal(result.routers.agent, undefined);
  assert.equal(result.routers.bookings, undefined);
  assert.equal(result.routers.widget, undefined);
  assert.equal(result.routers.channels, undefined);
});

test("channels on with no providers registered logs one warning at mount, and not when a provider is registered", () => {
  const warnings = (registry?: ChannelRegistry) => {
    const { app } = fakeApp();
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const logger = {
      warn: (event: string, fields: Record<string, unknown>) => events.push({ event, fields }),
      error: () => {},
    };
    const base = deps({ [WIRING_FLAGS.CHANNELS]: "true" });
    mountChatbotModule(app, { ...base, channels: { onReceipt: async () => {}, logger, registry } });
    return events.filter((e) => e.event === "chatbot.channels.registry_empty");
  };

  const empty = warnings();
  assert.equal(empty.length, 1);
  assert.deepEqual(empty[0].fields, { flag: WIRING_FLAGS.CHANNELS });

  const withProvider = warnings({ kinds: () => ["telegram"] } as unknown as ChannelRegistry);
  assert.equal(withProvider.length, 0);
});

const COMPANY = "11111111-1111-4111-8111-111111111111";

/** Drizzle-shaped stub for db.select().from().where().limit(). Counts queries; answers with rows or throws. */
function stubDb(outcome: { rows?: unknown[]; error?: Error }) {
  const state = { queries: 0 };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            state.queries += 1;
            if (outcome.error) throw outcome.error;
            return outcome.rows ?? [];
          },
        }),
      }),
    }),
  };
  return { db: db as unknown as ChatbotWiringDeps["db"], state };
}

test("default human-agent rule: allowed only when the company has an active agent", async () => {
  const withAgent = stubDb({ rows: [{ id: "u1" }] });
  assert.equal(await resolveHasHumanAgents({ db: withAgent.db })(COMPANY), true);
  assert.equal(withAgent.state.queries, 1);

  const noAgent = stubDb({ rows: [] });
  assert.equal(await resolveHasHumanAgents({ db: noAgent.db })(COMPANY), false);
});

test("default human-agent rule fails closed on a bad company id without querying", async () => {
  const stub = stubDb({ rows: [{ id: "u1" }] });
  assert.equal(await resolveHasHumanAgents({ db: stub.db })("not-a-uuid"), false);
  assert.equal(stub.state.queries, 0);
});

test("default human-agent rule fails closed on a lookup error and reports only the event name", async () => {
  const stub = stubDb({ error: new Error("connect failed: postgres://user:hunter2@db/secret") });
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    assert.equal(await resolveHasHumanAgents({ db: stub.db })(COMPANY), false);
  } finally {
    console.error = original;
  }
  // The shared logger adds a timestamp and level prefix, so match the event name, not the exact args.
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /\[ERROR\] chatbot\.agent\.has_human_agents_lookup_failed$/);
  assert.ok(!JSON.stringify(logged).includes("hunter2"));
});

test("an injected hasHumanAgents overrides the default and never touches the db", async () => {
  const stub = stubDb({ rows: [{ id: "u1" }] });
  const deny = resolveHasHumanAgents({ db: stub.db, hasHumanAgents: async () => false });
  assert.equal(await deny(COMPANY), false);
  const allow = resolveHasHumanAgents({ db: stub.db, hasHumanAgents: async () => true });
  assert.equal(await allow(COMPANY), true);
  assert.equal(stub.state.queries, 0);
});

test("DEMO_MODE is on only when exactly \"true\", and the cap passes through", () => {
  const cases: [Record<string, string | undefined>, boolean][] = [
    [{ DEMO_MODE: "true" }, true],
    [{ DEMO_MODE: "TRUE" }, false],
    [{ DEMO_MODE: "1" }, false],
    [{ DEMO_MODE: " true" }, false],
    [{ DEMO_MODE: "" }, false],
    [{}, false],
  ];
  for (const [env, expected] of cases) {
    const { app } = fakeApp();
    const result = mountChatbotModule(app, deps(env));
    assert.equal(result.voiceCall.demoMode, expected, `DEMO_MODE=${JSON.stringify(env.DEMO_MODE)}`);
  }

  const { app } = fakeApp();
  const capped = mountChatbotModule(app, { ...deps({ DEMO_MODE: "true" }), demoSecondsLimit: 90 });
  assert.deepEqual(capped.voiceCall, { demoMode: true, demoSecondsLimit: 90 });
});

test("demo mode is reported even when no chatbot surface is on", () => {
  const { app, calls } = fakeApp();
  const result = mountChatbotModule(app, deps({ DEMO_MODE: "true" }));
  assert.equal(calls.length, 0);
  assert.equal(result.voiceCall.demoMode, true);
});
