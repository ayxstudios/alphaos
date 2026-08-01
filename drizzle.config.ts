import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Secrets live in .env.local (gitignored), not .env.
config({ path: ".env.local" });

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Migrations run on the OWNER connection (DIRECT_URL) so DDL and RLS DDL
    // succeed; the app itself connects as the non-owner app_user via
    // DATABASE_URL. Falls back to DATABASE_URL when DIRECT_URL is unset.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
});
