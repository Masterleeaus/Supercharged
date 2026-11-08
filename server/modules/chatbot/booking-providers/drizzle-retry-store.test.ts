/**
 * Drizzle sealed-secret storage for Cal.com: the jsonb column holds the versioned string as a JSON string, and reads
 * open it. A row written by older code (a contract object) also opens. The database is a stand-in that mirrors the
 * jsonb round trip (JSON out, JSON back), so no Postgres is needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SECRET_KEY_ENV, createSecretBox } from "../secrets/secret-box.ts";
import { createCalendarSecretStore } from "./calendar-secrets.ts";
import { createDrizzleRetryStore } from "./drizzle-retry-store.ts";
import type { BookingProvidersDb } from "./drizzle-store.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const box = createSecretBox({ env });
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const API_KEY = "cal_live_drizzle_key_value";

/** Keeps the last inserted row as jsonb would: serialised on write, parsed on read. */
function fakeDb() {
  let row: Record<string, unknown> | null = null;
  const selectChain = {
    select: () => selectChain,
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => (row === null ? [] : [{ sealed: JSON.parse(JSON.stringify(row.sealed)) }]),
  };
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          row = JSON.parse(JSON.stringify(values));
        },
      }),
    }),
    select: selectChain.select,
  };
  return { db: db as unknown as BookingProvidersDb, rawRow: () => row };
}

test("round trip through the Drizzle store: the jsonb value is the versioned string and reads back", async () => {
  const { db, rawRow } = fakeDb();
  const storage = createDrizzleRetryStore(db).secrets;
  const store = createCalendarSecretStore({ box, storage });
  await store.save(COMPANY_A, "calcom", "api_key", API_KEY);

  const stored = rawRow()?.sealed;
  assert.equal(typeof stored, "string");
  assert.match(String(stored), /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(await store.read(COMPANY_A, "calcom", "api_key"), API_KEY);
});

test("legacy read: a contract object in the jsonb column still opens", async () => {
  const { db, rawRow } = fakeDb();
  const storage = createDrizzleRetryStore(db).secrets;
  const legacy = await box.encrypt(COMPANY_A, API_KEY);
  await storage.put(COMPANY_A, "calcom", "api_key", legacy, new Date());
  assert.equal(typeof rawRow()?.sealed, "object");

  const store = createCalendarSecretStore({ box, storage });
  assert.equal(await store.read(COMPANY_A, "calcom", "api_key"), API_KEY);
});
