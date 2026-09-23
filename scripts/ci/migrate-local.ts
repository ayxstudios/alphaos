/**
 * Local/CI migrate. Same migration files and same drizzle journal
 * (drizzle.__drizzle_migrations) as `npm run db:migrate`, but run in-process so
 * the Neon driver goes through scripts/ci/neon-local-proxy.mjs. drizzle-kit
 * loads its own copy of the driver, which never sees NEON_LOCAL_PROXY.
 * Runs on DIRECT_URL (the owner), like drizzle-kit.
 */
import "../load-env";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import ws from "ws";

async function main() {
  if (!process.env.NEON_LOCAL_PROXY) {
    throw new Error("migrate-local is for the local proxy only; use npm run db:migrate against Neon");
  }
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DIRECT_URL!, max: 1 });
  await migrate(drizzle(pool), { migrationsFolder: "./lib/db/migrations" });
  await pool.end();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error("migrate failed:", err.cause?.message ?? err.message);
  process.exit(1);
});
