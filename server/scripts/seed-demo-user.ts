import "dotenv/config";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";

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
      console.log(`User ${demoUser.email} already exists. Updating password and role...`);
      await db
        .update(users)
        .set({
          password: hashedPassword,
          role: demoUser.role,
          isActive: true
        })
        .where(eq(users.id, existingUser.id));
      console.log(`Updated user ${demoUser.email} successfully.`);
    } else {
      console.log(`Creating user ${demoUser.email}...`);
      await db.insert(users).values({
        email: demoUser.email,
        password: hashedPassword,
        name: demoUser.name,
        role: demoUser.role,
        isActive: true,
        credits: 1000, // Give them initial credits to use the application
      });
      console.log(`Created user ${demoUser.email} successfully.`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Failed to seed demo users:", err);
  process.exit(1);
});
