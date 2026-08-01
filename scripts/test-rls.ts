/**
 * RLS isolation proof. Runs entirely through the APP connection (app_user via
 * DATABASE_URL) so the row-level security policies are actually in force, and
 * asserts the guarantees from CLAUDE.md. Prints PASS/FAIL per assertion and
 * exits non-zero if any assertion fails.
 *
 * Requires `npm run seed` to have populated the database first.
 *
 * Designer A = d2 (PixArt only). Designer B = d1 (spans both, also has PixArt
 * orders) — so A must NOT see B's orders even within the same business.
 */
// Must be first: loads .env.local before lib/db builds its Pool from DATABASE_URL.
import "./load-env";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { db, withUserContext, schema, type RequestUser } from "../lib/db";

let failures = 0;
function report(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
  if (!pass) failures += 1;
}

const asUser = (id: string, role: RequestUser["role"]): RequestUser => ({
  id,
  role,
});

// Surface the underlying Postgres error, not the Drizzle wrapper line.
function rootMsg(err: unknown): string {
  const cause = (err as { cause?: Error }).cause;
  return (cause?.message ?? (err as Error).message).split("\n")[0];
}

async function userId(email: string): Promise<string> {
  const [u] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  if (!u) throw new Error(`seed user not found: ${email} (run npm run seed)`);
  return u.id;
}

async function main() {
  if (new URL(process.env.DATABASE_URL!).username !== "app_user") {
    throw new Error(
      "DATABASE_URL must connect as app_user for RLS to apply — refusing to run.",
    );
  }

  const admin = await userId("admin@aystudios.io");
  const va1 = await userId("va1@aystudios.io");
  const d1 = await userId("d1@aystudios.io"); // Designer B (spans both)
  const d2 = await userId("d2@aystudios.io"); // Designer A (PixArt only)

  // Ground truth (as admin): which orders each designer is actively assigned.
  const assignedTo = (designerId: string) =>
    withUserContext(asUser(admin, "admin"), (tx) =>
      tx
        .select({ id: schema.assignments.orderId })
        .from(schema.assignments)
        .where(
          and(
            eq(schema.assignments.designerId, designerId),
            eq(schema.assignments.active, true),
          ),
        ),
    );
  const d2Assigned = new Set((await assignedTo(d2)).map((r) => r.id));
  const d1Assigned = new Set((await assignedTo(d1)).map((r) => r.id));

  // -- 1. Designer A sees ONLY their assigned orders, not Designer B's --------
  {
    const seen = await withUserContext(asUser(d2, "designer"), (tx) =>
      tx.select({ id: schema.orders.id }).from(schema.orders),
    );
    const seenIds = new Set(seen.map((r) => r.id));
    const leaked = [...seenIds].filter((id) => d1Assigned.has(id));
    const exactlyOwn =
      seenIds.size === d2Assigned.size &&
      [...seenIds].every((id) => d2Assigned.has(id));
    const pass = seenIds.size > 0 && exactlyOwn && leaked.length === 0;
    report(
      "Designer A sees only own assigned orders",
      pass,
      `A saw ${seenIds.size} orders (own assigned=${d2Assigned.size}); ` +
        `B has ${d1Assigned.size} orders; leaked from B: ${leaked.length}`,
    );
  }

  // -- 2. Designer A cannot read the customers table at all -------------------
  {
    const adminCount = (
      await withUserContext(asUser(admin, "admin"), (tx) =>
        tx.select({ id: schema.customers.id }).from(schema.customers),
      )
    ).length;
    const designerRows = await withUserContext(asUser(d2, "designer"), (tx) =>
      tx.select({ id: schema.customers.id }).from(schema.customers),
    );
    const pass = adminCount > 0 && designerRows.length === 0;
    report(
      "Designer A cannot read customers table",
      pass,
      `admin sees ${adminCount} customers; designer sees ${designerRows.length}`,
    );
  }

  // -- 3. Designer A CAN read customer_public (first_name) but NOT email ------
  {
    const rows = await withUserContext(asUser(d2, "designer"), (tx) =>
      tx
        .select({
          id: schema.customerPublic.id,
          firstName: schema.customerPublic.firstName,
        })
        .from(schema.customerPublic),
    );
    const hasFirstNames =
      rows.length > 0 && rows.every((r) => !!r.firstName);

    let emailBlocked = false;
    let emailDetail = "";
    try {
      await withUserContext(asUser(d2, "designer"), (tx) =>
        tx.execute(sql`select email from customer_public limit 1`),
      );
      emailDetail = "email column was readable (unexpected)";
    } catch (err) {
      emailBlocked = true;
      emailDetail = `email rejected: ${rootMsg(err)}`;
    }

    const pass = hasFirstNames && emailBlocked;
    report(
      "Designer A reads customer_public first_name but not email",
      pass,
      `rows=${rows.length}, all have first_name=${hasFirstNames}; ${emailDetail}`,
    );
  }

  // -- 4. VA sees all orders across all businesses ---------------------------
  {
    const rows = await withUserContext(asUser(va1, "va"), (tx) =>
      tx
        .select({ id: schema.orders.id, businessId: schema.orders.businessId })
        .from(schema.orders),
    );
    const businesses = new Set(rows.map((r) => r.businessId));
    const pass = rows.length === 20 && businesses.size === 2;
    report(
      "VA sees all orders across all businesses",
      pass,
      `VA saw ${rows.length} orders across ${businesses.size} businesses (expected 20 / 2)`,
    );
  }

  // -- 5. activity_log is immutable (UPDATE and DELETE both fail) -------------
  {
    // Seed one row as admin (INSERT is permitted).
    const pixart = (
      await withUserContext(asUser(admin, "admin"), (tx) =>
        tx
          .select({ id: schema.businesses.id })
          .from(schema.businesses)
          .where(eq(schema.businesses.slug, "pixart")),
      )
    )[0].id;
    await withUserContext(asUser(admin, "admin"), (tx) =>
      tx.insert(schema.activityLog).values({
        businessId: pixart,
        action: "rls.test.probe",
        metadata: { note: "immutability probe" },
      }),
    );

    let updateBlocked = false;
    let updateMsg = "";
    try {
      await withUserContext(asUser(admin, "admin"), (tx) =>
        tx.execute(
          sql`update activity_log set action = 'tampered' where action = 'rls.test.probe'`,
        ),
      );
    } catch (err) {
      updateBlocked = true;
      updateMsg = rootMsg(err);
    }

    let deleteBlocked = false;
    let deleteMsg = "";
    try {
      await withUserContext(asUser(admin, "admin"), (tx) =>
        tx.execute(
          sql`delete from activity_log where action = 'rls.test.probe'`,
        ),
      );
    } catch (err) {
      deleteBlocked = true;
      deleteMsg = rootMsg(err);
    }

    const pass = updateBlocked && deleteBlocked;
    report(
      "activity_log is append-only (UPDATE and DELETE rejected)",
      pass,
      `UPDATE blocked=${updateBlocked} (${updateMsg}); DELETE blocked=${deleteBlocked} (${deleteMsg})`,
    );
  }

  console.log(
    `\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"} ` +
      `(${5 - failures}/5 assertions passed)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test-rls crashed:", err);
  process.exit(1);
});
