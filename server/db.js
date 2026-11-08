import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../shared/schema.js";
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?"
  );
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 3e4,
  connectionTimeoutMillis: 1e4
});
if (process.env.DATABASE_URL) {
  const maskedUrl = process.env.DATABASE_URL.replace(/:[^:]+@/, ":****@");
  console.log(`\u{1F50C} [DB Pool] Initialized connection to: ${maskedUrl}`);
} else {
  console.error(`\u{1F50C} [DB Pool] DATABASE_URL is not set!`);
}
pool.on("error", (err) => {
  console.error("[DB Pool] Idle client error:", err.message);
});
const db = drizzle(pool, { schema });
export {
  db,
  pool
};
