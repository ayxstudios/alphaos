// Two owners on /approve (lib/qc/claims.ts, Yousif 2026-10-14): the first to
// open an order keeps it, the other is refused, a lapsed claim frees it.
// Pure checks always run. The database checks run only with CLAIMS_DB_URL set
// to an APP (app_user, RLS in force) connection, e.g. staging's
// STAGING_DATABASE_URL; they run inside one transaction that is rolled back.
import assert from "node:assert/strict";

import { claimedMessage, holderName, summarizeOthers } from "../lib/qc/claims";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

check("name used", holderName({ name: " Ayser ", email: "x@y.z" }) === "Ayser");
check(
  "email local part when no name",
  holderName({ name: null, email: "yousif@x.com" }) === "yousif",
);
check(
  "message names the holder",
  claimedMessage("Ayser") === "Ayser is already checking this one.",
);
check(
  "others summarised per person",
  JSON.stringify(
    summarizeOthers([
      { holderId: "b", holder: "Yousif" },
      { holderId: "a", holder: "Ayser" },
      { holderId: "a", holder: "Ayser" },
    ]),
  ) ===
    JSON.stringify([
      { name: "Ayser", count: 2 },
      { name: "Yousif", count: 1 },
    ]),
);

class Rollback extends Error {}

async function dbChecks(url: string) {
  process.env.DATABASE_URL = url;
  const { db } = await import("../lib/db");
  const { sql } = await import("drizzle-orm");
  const { takeClaim, claimHolder, dropClaim, othersClaims } =
    await import("../lib/qc/claims");
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  const as = (tx: Tx, id: string, role: string) =>
    tx.execute(
      sql`select set_config('app.user_id', ${id}, true), set_config('app.role', ${role}, true)`,
    );
  try {
    await db.transaction(async (tx) => {
      await as(tx, "system", "admin");
      const staff = await tx.execute(
        sql`select id, name, role from "user" where active and role in ('admin','va') order by role, email limit 50`,
      );
      const rows = staff.rows as { id: string; name: string; role: string }[];
      const a = rows.find((r) => r.role === "admin");
      const b = rows.find((r) => r.role === "va");
      const ord = (
        await tx.execute(
          sql`select id from orders where status = 'awaiting_qc' limit 1`,
        )
      ).rows[0] as { id: string } | undefined;
      assert(a && b && ord, "needs an admin, a VA and an order awaiting QC");

      await as(tx, a.id, "admin");
      check("A takes a free order", (await takeClaim(tx, ord.id, a.id)).ok);
      check("A refreshes own claim", (await takeClaim(tx, ord.id, a.id)).ok);
      check(
        "A sees no other holder",
        (await claimHolder(tx, ord.id, a.id)) === null,
      );

      await as(tx, b.id, "va");
      const refused = await takeClaim(tx, ord.id, b.id);
      check(
        "B refused while A's claim is fresh",
        !refused.ok && refused.holderId === a.id,
        JSON.stringify(refused),
      );
      check(
        "B is told A holds it",
        (await claimHolder(tx, ord.id, b.id))?.holderId === a.id,
      );
      check(
        "A's order kept out of B's queue",
        (await othersClaims(tx, b.id)).some((c) => c.orderId === ord.id),
      );
      await dropClaim(tx, ord.id, b.id);
      check(
        "B cannot release A's claim",
        (await claimHolder(tx, ord.id, b.id))?.holderId === a.id,
      );

      await tx.execute(
        sql`update qc_claims set seen_at = now() - interval '4 minutes' where order_id = ${ord.id}`,
      );
      check(
        "lapsed claim frees the order",
        (await claimHolder(tx, ord.id, b.id)) === null,
      );
      check("B takes the lapsed order", (await takeClaim(tx, ord.id, b.id)).ok);

      await as(tx, a.id, "admin");
      const back = await takeClaim(tx, ord.id, a.id);
      check("A now refused (B holds it)", !back.ok && back.holderId === b.id);
      check(
        "B's order kept out of A's queue",
        (await othersClaims(tx, a.id)).some((c) => c.orderId === ord.id),
      );
      await as(tx, b.id, "va");
      check(
        "own claim never hides my own queue",
        !(await othersClaims(tx, b.id)).some((c) => c.orderId === ord.id),
      );

      await as(tx, b.id, "va");
      await dropClaim(tx, ord.id, b.id);
      await as(tx, a.id, "admin");
      check(
        "A takes it once B lets go",
        (await takeClaim(tx, ord.id, a.id)).ok,
      );

      // RLS: a designer can neither read nor write claims.
      await tx.execute(sql`savepoint designer_probe`);
      await as(tx, "designer-probe", "designer");
      const seen = (
        await tx.execute(sql`select count(*)::int as n from qc_claims`)
      ).rows[0] as { n: number };
      check("designer reads no claims", seen.n === 0, `saw ${seen.n}`);
      let wrote = true;
      try {
        await tx.execute(
          sql`insert into qc_claims (order_id, user_id) values (${ord.id}, ${a.id}) on conflict do nothing`,
        );
      } catch {
        wrote = false;
      }
      check("designer cannot write a claim", !wrote);
      await tx.execute(sql`rollback to savepoint designer_probe`);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

(async () => {
  const url = process.env.CLAIMS_DB_URL;
  if (url) await dbChecks(url);
  else
    console.log(
      "skip database checks (set CLAIMS_DB_URL to an app_user connection)",
    );
  console.log(
    failed ? `test-qc-claims FAILED (${failed})` : "test-qc-claims OK",
  );
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
