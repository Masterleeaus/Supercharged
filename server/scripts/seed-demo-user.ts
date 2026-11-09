import "dotenv/config";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { logger } from '../utils/logger.ts';

async function main() {
  const password = "Demo@123";
  const hashedPassword = await bcrypt.hash(password, 10);
  
  const demoUsers = [
    {
      email: "demo@diploy.in",
      name: "Demo Admin",
      role: "admin",
    },
    {
      email: "demo1@diploy.in",
      name: "Demo User 1",
      role: "admin",
    }
  ];

  for (const demoUser of demoUsers) {
    // Check if user exists
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, demoUser.email))
      .limit(1);

    if (existingUser) {
      logger.info(`User [redacted] already exists. Updating password and role...`);
      await db
        .update(users)
        .set({
          password: hashedPassword,
          role: demoUser.role,
          isActive: true
        })
        .where(eq(users.id, existingUser.id));
      logger.info(`Updated user [redacted] successfully.`);
    } else {
      logger.info(`Creating user [redacted]...`);
      await db.insert(users).values({
        email: demoUser.email,
        password: hashedPassword,
        name: demoUser.name,
        role: demoUser.role,
        isActive: true,
        credits: 1000, // Give them initial credits to use the application
      });
      logger.info(`Created user [redacted] successfully.`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  logger.error("Failed to seed demo users:", err);
  process.exit(1);
});
