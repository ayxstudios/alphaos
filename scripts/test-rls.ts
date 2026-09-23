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
let total = 0;
function report(name: string, pass: boolean, detail: string) {
  total += 1;
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
    const adminRows = await withUserContext(asUser(admin, "admin"), (tx) =>
      tx
        .select({ id: schema.orders.id, businessId: schema.orders.businessId })
        .from(schema.orders),
    );
    const rows = await withUserContext(asUser(va1, "va"), (tx) =>
      tx
        .select({ id: schema.orders.id, businessId: schema.orders.businessId })
        .from(schema.orders),
    );
    const adminBusinesses = new Set(adminRows.map((r) => r.businessId));
    const businesses = new Set(rows.map((r) => r.businessId));
    const pass =
      rows.length === adminRows.length &&
      businesses.size === adminBusinesses.size &&
      businesses.size >= 2;
    report(
      "VA sees all orders across all businesses",
      pass,
      `VA saw ${rows.length}/${adminRows.length} admin-visible orders across ${businesses.size}/${adminBusinesses.size} businesses`,
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

  // -- 6. Designer cannot read the email thread, even on an assigned order ------
  // (0038_rls_designer_tighten: messages_select is staff only.)
  {
    const [own] = await withUserContext(asUser(admin, "admin"), (tx) =>
      tx
        .select({ orderId: schema.assignments.orderId, businessId: schema.assignments.businessId })
        .from(schema.assignments)
        .where(and(eq(schema.assignments.designerId, d2), eq(schema.assignments.active, true)))
        .limit(1),
    );
    const probeId = `rls-msg-probe-${Date.now()}`;
    await withUserContext(asUser(admin, "admin"), (tx) =>
      tx.insert(schema.messages).values({
        id: probeId,
        businessId: own.businessId,
        orderId: own.orderId,
        direction: "inbound",
        channel: "email",
        status: "received",
        subject: "rls probe",
        body: "from buyer@example.com",
        address: "buyer@example.com",
      }),
    );
    const staffSees = await withUserContext(asUser(va1, "va"), (tx) =>
      tx.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.id, probeId)),
    );
    const designerSees = await withUserContext(asUser(d2, "designer"), (tx) =>
      tx.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.orderId, own.orderId)),
    );
    await withUserContext(asUser(admin, "admin"), (tx) =>
      tx.delete(schema.messages).where(eq(schema.messages.id, probeId)),
    );
    report(
      "Designer cannot read messages on their own assigned order",
      staffSees.length === 1 && designerSees.length === 0,
      `VA sees probe=${staffSees.length}; designer sees ${designerSees.length} messages on assigned order`,
    );
  }

  // -- 7. Designer cannot rewrite their own profile (rank, capacity) ----------
  {
    const before = await withUserContext(asUser(admin, "admin"), (tx) =>
      tx
        .select({ rank: schema.designerProfiles.rank, dailyCapacity: schema.designerProfiles.dailyCapacity })
        .from(schema.designerProfiles)
        .where(eq(schema.designerProfiles.userId, d2)),
    );
    let writeResult = "";
    try {
      const updated = await withUserContext(asUser(d2, "designer"), (tx) =>
        tx
          .update(schema.designerProfiles)
          .set({ rank: -1, dailyCapacity: 500 })
          .where(eq(schema.designerProfiles.userId, d2))
          .returning({ userId: schema.designerProfiles.userId }),
      );
      writeResult = `${updated.length} row(s) updated`;
    } catch (err) {
      writeResult = `rejected: ${rootMsg(err)}`;
    }
    const after = await withUserContext(asUser(admin, "admin"), (tx) =>
      tx
        .select({ rank: schema.designerProfiles.rank, dailyCapacity: schema.designerProfiles.dailyCapacity })
        .from(schema.designerProfiles)
        .where(eq(schema.designerProfiles.userId, d2)),
    );
    const unchanged =
      before.length === 1 &&
      after.length === 1 &&
      after[0].rank === before[0].rank &&
      after[0].dailyCapacity === before[0].dailyCapacity;
    report(
      "Designer cannot change their own rank or capacity",
      unchanged,
      `designer write: ${writeResult}; rank ${before[0]?.rank}->${after[0]?.rank}, capacity ${before[0]?.dailyCapacity}->${after[0]?.dailyCapacity}`,
    );
  }

  await tightenedR2(admin, va1, d1, d2);

  console.log(
    `\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"} ` +
      `(${total - failures}/${total} assertions passed)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** Run `fn`; "rejected: <pg message>" if Postgres refused it, else its result. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; msg: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, msg: rootMsg(err) };
  }
}

/**
 * 0040_rls_tighten_r2 (security QA r2, remaining P2s): each policy that was
 * wider than the app uses, proven narrow, with the app's own use still working.
 */
async function tightenedR2(admin: string, va1: string, d1: string, d2: string) {
  const asAdmin = asUser(admin, "admin");
  const asVa = asUser(va1, "va");
  const asD2 = asUser(d2, "designer");
  const [own] = await withUserContext(asAdmin, (tx) =>
    tx
      .select({ orderId: schema.assignments.orderId, businessId: schema.assignments.businessId })
      .from(schema.assignments)
      .where(and(eq(schema.assignments.designerId, d2), eq(schema.assignments.active, true)))
      .limit(1),
  );
  const businesses = await withUserContext(asAdmin, (tx) => tx.select({ id: schema.businesses.id }).from(schema.businesses));
  const d2Businesses = new Set(
    (
      await withUserContext(asAdmin, (tx) =>
        tx.select({ b: schema.designerBusinesses.businessId }).from(schema.designerBusinesses).where(eq(schema.designerBusinesses.userId, d2)),
      )
    ).map((r) => r.b),
  );
  const foreignBusiness = businesses.find((b) => !d2Businesses.has(b.id))?.id;

  // -- 8. "user": no self-promotion; own-row writes and sign-in reads still work
  {
    const roleWrite = await attempt(() =>
      withUserContext(asD2, (tx) =>
        tx.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, d2)).returning({ id: schema.users.id }),
      ),
    );
    const ownWrite = await attempt(() =>
      withUserContext(asD2, (tx) =>
        tx.update(schema.users).set({ sessionsValidAfter: null }).where(eq(schema.users.id, d2)).returning({ id: schema.users.id }),
      ),
    );
    const otherWrite = await attempt(() =>
      withUserContext(asVa, (tx) =>
        tx.update(schema.users).set({ name: "Tampered" }).where(eq(schema.users.id, d1)).returning({ id: schema.users.id }),
      ),
    );
    const noContextRead = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, d2));
    const [after] = await db.select({ role: schema.users.role, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, d2));
    const [d1After] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, d1));
    const pass =
      !roleWrite.ok &&
      after?.role === "designer" &&
      ownWrite.ok &&
      ownWrite.value.length === 1 &&
      (!otherWrite.ok || otherWrite.value.length === 0) &&
      d1After?.name !== "Tampered" &&
      noContextRead.length === 1;
    report(
      "user: a designer cannot change their own role; own-row writes and no-context sign-in reads still work",
      pass,
      `role write ${roleWrite.ok ? "ALLOWED" : "rejected"}; own write ${ownWrite.ok ? ownWrite.value.length + " row" : "rejected: " + ownWrite.msg}; VA edit of another user ${otherWrite.ok ? otherWrite.value.length + " rows" : "rejected"}; raw read ${noContextRead.length}`,
    );
  }

  // -- 9. designer_businesses: a designer cannot attach themselves elsewhere --
  {
    const attach = foreignBusiness
      ? await attempt(() =>
          withUserContext(asD2, (tx) => tx.insert(schema.designerBusinesses).values({ userId: d2, businessId: foreignBusiness })),
        )
      : { ok: false as const, msg: "no foreign business in seed" };
    const seen = await withUserContext(asD2, (tx) => tx.select({ u: schema.designerBusinesses.userId }).from(schema.designerBusinesses));
    const staffSeen = await withUserContext(asVa, (tx) => tx.select({ u: schema.designerBusinesses.userId }).from(schema.designerBusinesses));
    if (attach.ok && foreignBusiness) {
      await withUserContext(asAdmin, (tx) =>
        tx.delete(schema.designerBusinesses).where(and(eq(schema.designerBusinesses.userId, d2), eq(schema.designerBusinesses.businessId, foreignBusiness))),
      );
    }
    report(
      "designer_businesses: a designer cannot attach themselves to another business and sees only their own rows",
      !attach.ok && !!foreignBusiness && seen.length > 0 && seen.every((r) => r.u === d2) && staffSeen.length > seen.length,
      `attach ${attach.ok ? "ALLOWED" : "rejected: " + attach.msg}; designer sees ${seen.length} (all own=${seen.every((r) => r.u === d2)}), VA sees ${staffSeen.length}`,
    );
  }

  // -- 10. customer_public: only customers of the designer's own orders ------
  {
    const allowed = new Set(
      (
        await withUserContext(asAdmin, (tx) =>
          tx
            .select({ c: schema.orders.customerId })
            .from(schema.orders)
            .innerJoin(schema.assignments, and(eq(schema.assignments.orderId, schema.orders.id), eq(schema.assignments.active, true)))
            .where(eq(schema.assignments.designerId, d2)),
        )
      )
        .map((r) => r.c)
        .filter((c): c is string => !!c),
    );
    const seen = await withUserContext(asD2, (tx) => tx.select({ id: schema.customerPublic.id }).from(schema.customerPublic));
    const inBusiness = await withUserContext(asAdmin, (tx) => tx.select({ id: schema.customers.id, b: schema.customers.businessId }).from(schema.customers));
    const businessCount = inBusiness.filter((c) => d2Businesses.has(c.b)).length;
    report(
      "customer_public: a designer sees first names only for customers of their own orders",
      seen.length > 0 && seen.every((r) => r.id && allowed.has(r.id)),
      `designer sees ${seen.length} (all on own orders=${seen.every((r) => r.id && allowed.has(r.id))}); ${businessCount} customers in their businesses`,
    );
  }

  // -- 11. activity_log / assets: designer rows carry their own id, own order -
  {
    const forged = await attempt(() =>
      withUserContext(asD2, (tx) =>
        tx.insert(schema.activityLog).values({ businessId: own.businessId, orderId: own.orderId, actorId: d1, action: "rls.test.forged_actor" }),
      ),
    );
    const ownRow = await attempt(() =>
      withUserContext(asD2, (tx) =>
        tx.insert(schema.activityLog).values({ businessId: own.businessId, orderId: own.orderId, actorId: d2, action: "rls.test.own_actor" }),
      ),
    );
    const refAsset = await attempt(() =>
      withUserContext(asD2, (tx) =>
        tx.insert(schema.assets).values({ businessId: own.businessId, orderId: own.orderId, type: "reference", storage: "cdn", url: "https://example.com/r.jpg", uploadedBy: d2 }),
      ),
    );
    const otherUploader = await attempt(() =>
      withUserContext(asD2, (tx) =>
        tx.insert(schema.assets).values({ businessId: own.businessId, orderId: own.orderId, type: "submission", storage: "cdn", url: "https://example.com/s.jpg", uploadedBy: d1 }),
      ),
    );
    const ownSubmission = await attempt(() =>
      withUserContext(asD2, (tx) =>
        tx
          .insert(schema.assets)
          .values({ businessId: own.businessId, orderId: own.orderId, type: "submission", storage: "cdn", url: "https://example.com/own.jpg", uploadedBy: d2 })
          .returning({ id: schema.assets.id }),
      ),
    );
    if (ownSubmission.ok) {
      await withUserContext(asAdmin, (tx) => tx.delete(schema.assets).where(eq(schema.assets.id, ownSubmission.value[0].id)));
    }
    report(
      "activity_log and assets: a designer cannot forge the actor/uploader or add a reference photo; own rows still insert",
      !forged.ok && ownRow.ok && !refAsset.ok && !otherUploader.ok && ownSubmission.ok,
      `forged actor ${forged.ok ? "ALLOWED" : "rejected"}; own activity ${ownRow.ok ? "ok" : ownRow.msg}; reference ${refAsset.ok ? "ALLOWED" : "rejected"}; other uploader ${otherUploader.ok ? "ALLOWED" : "rejected"}; own submission ${ownSubmission.ok ? "ok" : ownSubmission.msg}`,
    );
  }

  // -- 12. VA cannot delete (restrictive admin-only DELETE) --------------------
  {
    const [probe] = await withUserContext(asAdmin, (tx) =>
      tx
        .insert(schema.customers)
        .values({ businessId: own.businessId, email: `rls-delete-probe-${Date.now()}@example.com`, firstName: "Probe" })
        .returning({ id: schema.customers.id }),
    );
    const vaDelete = await attempt(() =>
      withUserContext(asVa, (tx) => tx.delete(schema.customers).where(eq(schema.customers.id, probe.id)).returning({ id: schema.customers.id })),
    );
    const adminDelete = await withUserContext(asAdmin, (tx) =>
      tx.delete(schema.customers).where(eq(schema.customers.id, probe.id)).returning({ id: schema.customers.id }),
    );
    report(
      "VA cannot delete rows (customers probe); an admin can",
      (!vaDelete.ok || vaDelete.value.length === 0) && adminDelete.length === 1,
      `VA delete ${vaDelete.ok ? vaDelete.value.length + " rows" : "rejected"}; admin delete ${adminDelete.length} row`,
    );
  }

  // -- 13. Auth.js adapter tables are closed to the app role -------------------
  {
    const read = await attempt(() => withUserContext(asAdmin, (tx) => tx.execute(sql`select 1 from "session" limit 1`)));
    report(
      "Auth.js session table (unused, JWT sessions) is not readable by app_user",
      !read.ok && /permission denied/i.test(read.msg),
      read.ok ? "readable (unexpected)" : read.msg,
    );
  }
}

main().catch((err) => {
  console.error("test-rls crashed:", err);
  process.exit(1);
});
