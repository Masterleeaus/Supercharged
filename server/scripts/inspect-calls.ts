import { db } from "../db.ts";
import { calls, twilioOpenaiCalls, plivoCalls, sipCalls, users } from "@shared/schema";
import { desc } from "drizzle-orm";
import { logger } from '../utils/logger.ts';

async function main() {
  logger.info("=== LATEST USERS ===");
  const latestUsers = await db.select().from(users).limit(5);
  logger.info(latestUsers.map(u => ({ id: u.id })));

  logger.info("=== LATEST CALLS (calls) ===");
  const c = await db.select().from(calls).orderBy(desc(calls.createdAt)).limit(5);
  logger.info(c.map(x => ({ id: x.id, userId: x.userId, createdAt: x.createdAt, status: x.status })));

  logger.info("=== LATEST TWILIO CALLS (twilioOpenaiCalls) ===");
  const t = await db.select().from(twilioOpenaiCalls).orderBy(desc(twilioOpenaiCalls.createdAt)).limit(5);
  logger.info(t.map(x => ({ id: x.id, userId: x.userId, createdAt: x.createdAt, status: x.status })));

  logger.info("=== LATEST PLIVO CALLS (plivoCalls) ===");
  const p = await db.select().from(plivoCalls).orderBy(desc(plivoCalls.createdAt)).limit(5);
  logger.info(p.map(x => ({ id: x.id, userId: x.userId, createdAt: x.createdAt, status: x.status })));

  logger.info("=== LATEST SIP CALLS (sipCalls) ===");
  const s = await db.select().from(sipCalls).orderBy(desc(sipCalls.createdAt)).limit(5);
  logger.info(s.map(x => ({ id: x.id, userId: x.userId, createdAt: x.createdAt, status: x.status })));
}

main().catch(err => {
  logger.error("Inspect calls failed", err);
  process.exit(1);
});
