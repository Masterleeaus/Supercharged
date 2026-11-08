// PROPOSED TEMPLATE. Not verified against the real repo, which may already have a drizzle.config.ts.
// Check that file before using this one.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './shared/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
