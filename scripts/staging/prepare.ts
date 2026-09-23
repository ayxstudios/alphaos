/**
 * Make a fresh production clone safe and testable (docs/STAGING.md). Run on
 * the STAGING owner connection right after scripts/staging/clone-prod.ts:
 *
 *   TARGET_URL=<staging owner url> APP_USER_PASSWORD=... \
 *   STAGING_ADMIN_PASSWORD=... STAGING_VA_PASSWORD=... STAGING_DESIGNER_PASSWORD=... \
 *     npx tsx scripts/staging/prepare.ts
 *
 * 1. app_user can log in (so DATABASE_URL runs under RLS, like the design says)
 * 2. three test logins (admin, VA, designer); the designer is attached to
 *    PixArt and given two ready_to_assign orders so their board is not empty
 * 3. disarm: no customer email, no health email, no Gmail/print credentials,
 *    no shop API credentials
 * 4. prints a verification of all of the above
 *
 * Refuses to touch the production endpoint.
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { and, eq, sql } from "drizzle-orm";
import ws from "ws";

import * as schema from "../../lib/db/schema";
import { hashPassword } from "../../lib/auth/password";
import { createAssignment } from "../../lib/orders/assign";
import type { Tx } from "../../lib/db";

neonConfig.webSocketConstructor = ws;

const PROD_ENDPOINT = "ep-spring-dawn-audsesft";
const STAGING_USERS = [
  { email: "staging-admin@alphaos.test", name: "Staging Admin", role: "admin", env: "STAGING_ADMIN_PASSWORD" },
  { email: "staging-va@alphaos.test", name: "Staging VA", role: "va", env: "STAGING_VA_PASSWORD" },
  { email: "staging-designer@alphaos.test", name: "Staging Designer", role: "designer", env: "STAGING_DESIGNER_PASSWORD" },
] as const;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main() {
  const url = need("TARGET_URL");
  const host = new URL(url).hostname;
  if (host.includes(PROD_ENDPOINT)) throw new Error("TARGET_URL is the production database; refusing.");
  if (new URL(url).username !== "neondb_owner") throw new Error("TARGET_URL must be the owner connection");

  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });

  // 1. app_user login (identifier-safe: the password is passed as a literal via format())
  const appPw = need("APP_USER_PASSWORD");
  await pool.query(`do $$ begin execute format('alter role app_user with login password %L', '${appPw.replace(/'/g, "''")}'); end $$`);

  await db.transaction(async (tx) => {
    // 2. users
    const ids: Record<string, string> = {};
    for (const u of STAGING_USERS) {
      const passwordHash = await hashPassword(need(u.env));
      const [row] = await tx
        .insert(schema.users)
        .values({ email: u.email, name: u.name, role: u.role, passwordHash })
        .onConflictDoUpdate({ target: schema.users.email, set: { name: u.name, role: u.role, passwordHash } })
        .returning({ id: schema.users.id });
      ids[u.role] = row.id;
    }

    const [pixart] = await tx
      .select({ id: schema.businesses.id })
      .from(schema.businesses)
      .where(eq(schema.businesses.name, "PixArt"));
    if (!pixart) throw new Error("PixArt business not found in the clone");
    const designerId = ids.designer;
    await tx.insert(schema.designerBusinesses).values({ userId: designerId, businessId: pixart.id }).onConflictDoNothing();
    await tx.insert(schema.designerProfiles).values({ userId: designerId, dailyCapacity: 10 }).onConflictDoNothing();

    const already = await tx
      .select({ id: schema.assignments.id })
      .from(schema.assignments)
      .where(and(eq(schema.assignments.designerId, designerId), eq(schema.assignments.active, true)));
    if (already.length === 0) {
      const picks = await tx
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(and(eq(schema.orders.businessId, pixart.id), eq(schema.orders.status, "ready_to_assign")))
        .orderBy(schema.orders.createdAt)
        .limit(2);
      for (const p of picks) {
        await createAssignment(tx as unknown as Tx, {
          orderId: p.id,
          businessId: pixart.id,
          designerId,
          assignedBy: ids.admin,
          reason: "Staging test assignment.",
        });
      }
    }

    // 3. disarm everything that can reach the outside world
    await tx.update(schema.businesses).set({
      emailSendingEnabled: false,
      stageEmailAutoSend: false,
      dailyHealthEmailEnabled: false,
      gmailCredentials: null,
      printCredentials: null,
    });
    await tx.update(schema.shops).set({ credentials: sql`'{}'::jsonb` });
  });

  // 4. verify
  const v = await pool.query(`
    select
      (select count(*) from businesses where email_sending_enabled or stage_email_auto_send or daily_health_email_enabled)::int as armed_businesses,
      (select count(*) from businesses where gmail_credentials is not null or print_credentials is not null)::int as businesses_with_creds,
      (select count(*) from shops where credentials <> '{}'::jsonb)::int as shops_with_creds,
      (select count(*) from "user" where email like 'staging-%@alphaos.test')::int as staging_users,
      (select count(*) from designer_businesses db join "user" u on u.id = db.user_id where u.email = 'staging-designer@alphaos.test')::int as designer_businesses,
      (select count(*) from assignments a join "user" u on u.id = a.designer_id where u.email = 'staging-designer@alphaos.test' and a.active)::int as designer_active_orders,
      (select rolcanlogin from pg_roles where rolname = 'app_user') as app_user_login,
      (select rolbypassrls from pg_roles where rolname = 'app_user') as app_user_bypassrls,
      (select count(*) from orders)::int as orders`);
  console.log(JSON.stringify(v.rows[0]));
  await pool.end();
  const r = v.rows[0];
  if (r.armed_businesses || r.businesses_with_creds || r.shops_with_creds || r.staging_users !== 3 || r.app_user_bypassrls) {
    throw new Error("staging verification failed");
  }
  console.log("staging prepared");
}

main().catch((err) => {
  console.error("prepare failed:", err.cause?.message ?? err.message);
  process.exit(1);
});
