import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import ws from "ws";

import * as schema from "./schema";

// The neon-http driver has NO transaction support, and per-request RLS needs a
// transaction to scope the `app.user_id` / `app.role` GUCs (verified: neon-http
// throws "No transactions support"). The neon-serverless WebSocket Pool driver
// supports interactive transactions, where `set_config(..., true)` persists
// across statements — exactly what withUserContext needs.
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });

/**
 * Raw database handle. Connects as `app_user`, so RLS is in force but NO tenant
 * GUCs are set — every query runs with `app.role` / `app.user_id` unset (NULL),
 * which the policies treat as "not staff, no businesses" → effectively denied.
 *
 * DO NOT use `db` directly in any request path (server action, route handler,
 * server component). Request-path queries MUST go through `withUserContext`,
 * which opens a transaction and sets the GUCs the RLS policies read. Direct use
 * is reserved for migrations/seeds/system jobs that run on the OWNER connection
 * and intentionally bypass RLS. See CLAUDE.md.
 */
export const db = drizzle(pool, { schema });

export { schema };

export type RequestUser = {
  id: string;
  role: "admin" | "va" | "designer";
};

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Synthetic actor id for system-initiated writes (never a real user row). */
export const SYSTEM_ACTOR_ID = "system";

/**
 * Run `fn` inside a transaction whose first statement sets the RLS GUCs for
 * `user`, so every query in `fn` is scoped by the row-level security policies.
 *
 * The GUCs are transaction-local (`set_config(..., true)`) and only hold for
 * the life of this transaction — exactly the queries in `fn`.
 */
export function withUserContext<T>(
  user: RequestUser,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${user.id}, true), set_config('app.role', ${user.role}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Run `fn` in an admin-scoped RLS context for BACKGROUND JOBS ONLY — the Etsy
 * sync, cron tasks, and route handlers that act on behalf of no signed-in user.
 *
 * It sets `app.role = 'admin'` (RLS grants full tenant access) with a synthetic
 * user id, so system-initiated writes should set `actor_id = null`.
 *
 * NEVER call this from a request path that serves a logged-in user — that would
 * silently escalate that request to full cross-tenant access. Request paths use
 * withUserContext with the real session user. See CLAUDE.md.
 */
export function withSystemContext<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withUserContext({ id: SYSTEM_ACTOR_ID, role: "admin" }, fn);
}
