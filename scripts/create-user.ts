/**
 * Create (or update) a user with a hashed password.
 *
 * Usage:
 *   npm run create-user -- <email> <name> <role> <password>
 * Example:
 *   npm run create-user -- me@aystudios.io "My Name" admin 'S3cret!'
 *
 * Runs on the OWNER connection (DIRECT_URL). Idempotent on email: re-running
 * updates the name, role, and password. There is no signup — this is the only
 * way (besides the seed) to mint an account.
 */
import "./load-env";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "../lib/db/schema";
import { hashPassword } from "../lib/auth/password";

neonConfig.webSocketConstructor = ws;

const ROLES = ["admin", "va", "designer"] as const;
type Role = (typeof ROLES)[number];

function usage(msg: string): never {
  console.error(`Error: ${msg}\n`);
  console.error('Usage: npm run create-user -- <email> <name> <role> <password>');
  console.error(`  role must be one of: ${ROLES.join(", ")}`);
  process.exit(1);
}

async function main() {
  const [emailRaw, name, roleRaw, password] = process.argv.slice(2);
  if (!emailRaw || !name || !roleRaw || !password) {
    usage("expected 4 arguments: email, name, role, password");
  }
  const email = emailRaw.trim().toLowerCase();
  if (!email.includes("@")) usage(`invalid email: ${emailRaw}`);
  if (!ROLES.includes(roleRaw as Role)) usage(`invalid role: ${roleRaw}`);
  if (password.length < 8) usage("password must be at least 8 characters");

  const url = process.env.DIRECT_URL;
  if (!url) usage("DIRECT_URL is not set (owner connection required)");
  if (new URL(url).username !== "neondb_owner") {
    usage("create-user must run on the owner connection (DIRECT_URL)");
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  const passwordHash = await hashPassword(password);
  await db
    .insert(schema.users)
    .values({ email, name, role: roleRaw as Role, passwordHash })
    .onConflictDoUpdate({
      target: schema.users.email,
      set: { name, role: roleRaw as Role, passwordHash },
    });

  await pool.end();
  console.log(`✓ User ready: ${email} (${roleRaw})`);
}

main().catch((err) => {
  console.error("create-user failed:", err);
  process.exit(1);
});
