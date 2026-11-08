/**
 * Telegram and Messenger drizzle stores: the write path persists the versioned string, and the read path opens both
 * the string and the older contract object. The database is a small recording stand-in, so no Postgres is needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createTelegramStore } from "./telegram/store.ts";
import { createMessengerStore } from "./messenger/store.ts";
import { SECRET_KEY_ENV, createSecretBox } from "../secrets/secret-box.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const box = createSecretBox({ env });
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const VALUES = { bot_token: "123:telegram-token-value", page_token: "page-token-value" };

/** Stand-in for the drizzle chain used by the stores: select().from().where().limit(), insert().values().onConflictDoUpdate(). */
function fakeDb(selectRows: Array<{ sealed: unknown }>) {
  const inserted: Array<Record<string, unknown>> = [];
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => selectRows,
    insert: () => chain,
    values(row: Record<string, unknown>) {
      inserted.push(row);
      return { onConflictDoUpdate: async () => undefined };
    },
  };
  return { db: chain as never, inserted };
}

for (const [name, make] of [
  ["telegram", createTelegramStore],
  ["messenger", createMessengerStore],
] as const) {
  test(`${name}: save persists the versioned string, and load reads it back`, async () => {
    const { db, inserted } = fakeDb([]);
    const store = make(db, box);
    await store.saveCredentials(COMPANY_A, "acct-1", VALUES);
    assert.equal(inserted.length, 1);
    assert.equal(typeof inserted[0].sealed, "string");
    assert.match(String(inserted[0].sealed), /^v1:/);

    const readBack = fakeDb([{ sealed: inserted[0].sealed }]);
    const loaded = await make(readBack.db, box).credentials.load(COMPANY_A, name, "acct-1");
    assert.deepEqual(loaded, VALUES);
  });

  test(`${name}: legacy read of a contract object still loads`, async () => {
    const legacy = await box.encrypt(COMPANY_A, JSON.stringify(VALUES));
    const { db } = fakeDb([{ sealed: JSON.parse(JSON.stringify(legacy)) }]);
    const loaded = await make(db, box).credentials.load(COMPANY_A, name, "acct-1");
    assert.deepEqual(loaded, VALUES);
  });

  test(`${name}: a row with no account returns null`, async () => {
    const { db } = fakeDb([]);
    assert.equal(await make(db, box).credentials.load(COMPANY_A, name, "missing"), null);
  });
}
