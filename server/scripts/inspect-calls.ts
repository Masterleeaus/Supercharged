import { db } from "../db.ts";
import { calls, twilioOpenaiCalls, plivoCalls, sipCalls, users } from "@shared/schema";
import { desc } from "drizzle-orm";

async function main() {
  console.log("=== LATEST USERS ===");
  const latestUsers = await db.select().from(users).limit(5);
  console.log(latestUsers.map(u => ({ id: u.id, name: u.name, email: u.email })));

  console.log("=== LATEST CALLS (calls) ===");
  const c = await db.select().from(calls).orderBy(desc(calls.createdAt)).limit(5);
  console.log(c.map(x => ({ id: x.id, userId: x.userId, fromNumber: x.fromNumber, toNumber: x.toNumber, createdAt: x.createdAt, status: x.status })));

  console.log("=== LATEST TWILIO CALLS (twilioOpenaiCalls) ===");
  const t = await db.select().from(twilioOpenaiCalls).orderBy(desc(twilioOpenaiCalls.createdAt)).limit(5);
  console.log(t.map(x => ({ id: x.id, userId: x.userId, fromNumber: x.fromNumber, toNumber: x.toNumber, createdAt: x.createdAt, status: x.status })));

  console.log("=== LATEST PLIVO CALLS (plivoCalls) ===");
  const p = await db.select().from(plivoCalls).orderBy(desc(plivoCalls.createdAt)).limit(5);
  console.log(p.map(x => ({ id: x.id, userId: x.userId, fromNumber: x.fromNumber, toNumber: x.toNumber, createdAt: x.createdAt, status: x.status })));

  console.log("=== LATEST SIP CALLS (sipCalls) ===");
  const s = await db.select().from(sipCalls).orderBy(desc(sipCalls.createdAt)).limit(5);
  console.log(s.map(x => ({ id: x.id, userId: x.userId, fromNumber: x.fromNumber, toNumber: x.toNumber, createdAt: x.createdAt, status: x.status })));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
