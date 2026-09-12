/**
 * Overdue sweep (2026-09-12): reconcile existing Etsy-sourced orders whose
 * status is stuck at `awaiting_details` even though Etsy's own receipt data
 * (stored in raw_import at the time of import) already says the order is
 * shipped, completed, cancelled or refunded.
 *
 * Root cause: importReceipt() in lib/integrations/etsy/receipts.ts always
 * inserted new orders as `awaiting_details`, regardless of what Etsy said
 * about the receipt. A backfilled historical order that was already
 * fulfilled — sometimes months ago, before AlphaOS ever synced the shop —
 * therefore sat forever as unshipped work, and once its due_at (placed_at +
 * turnaround) passed, it counted as overdue. On PixArt this produced the
 * "82 overdue" the 2026-09-11 morning rundown reported: 80 Completed + 1
 * Canceled + 1 Fully Refunded receipt, all still `awaiting_details`.
 *
 * The forward fix lives in etsyReceiptToInitialStatus() (receipts.ts) — new
 * imports now land in the right status. This script is the one-off
 * reconciliation for rows imported before that fix shipped. It is idempotent
 * (a second run finds nothing left to change) and touches ONLY orders whose
 * status is a non-terminal, still-open status while Etsy's own receipt
 * record says otherwise; it never touches an order a human has already
 * worked (e.g. moved to in_design, approved, printing) even if the receipt
 * looks "done", since the whole point is not to clobber real work in
 * progress. It writes an activity_log row for every change so the reasoning
 * is auditable, exactly like a normal transition.
 *
 * Usage:
 *   npx tsx scripts/overdue-sweep.ts                 # dry run, all businesses
 *   npx tsx scripts/overdue-sweep.ts --apply
 *   npx tsx scripts/overdue-sweep.ts --business <business-id> [--apply]
 */
import "./load-env";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import { etsyReceiptToInitialStatus } from "@/lib/integrations/etsy/receipts";
import type { EtsyReceipt } from "@/lib/integrations/etsy/types";

const apply = process.argv.includes("--apply");

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// Orders we will consider reassigning: still "open work" in our system, not
// yet touched by a human past intake. Anything further along the pipeline
// (ready_to_assign or later) is left alone even if Etsy's receipt looks
// done — a VA or designer may be mid-task on it.
const CANDIDATE_STATUSES = ["awaiting_details", "awaiting_photos"] as const;

type Row = {
  id: string;
  business_id: string;
  business_name: string;
  shop_id: string;
  platform_order_id: string;
  status: string;
  archived_at: string | null;
  due_at: string | null;
  raw_import: EtsyReceipt;
};

type ExecResult<T> = { rows: T[] };

async function main() {
  const businessId = arg("--business");
  console.log(apply ? "APPLY" : "DRY RUN");

  await withSystemContext(async (tx) => {
    const before = (await tx.execute(sql`
      select business_id, count(*) filter (
        where status not in ('shipped','delivered','complete','cancelled') and due_at < now()
      )::int as overdue
      from orders
      ${businessId ? sql`where business_id = ${businessId}` : sql``}
      group by business_id
    `)) as unknown as ExecResult<{ business_id: string; overdue: number }>;
    console.log("BEFORE (live+archived, overdue by status+due_at):", JSON.stringify(before.rows));

    const rows = (await tx.execute(sql`
      select o.id, o.business_id, b.name as business_name, o.shop_id,
             o.platform_order_id, o.status, o.archived_at, o.due_at, o.raw_import
      from orders o
      join businesses b on b.id = o.business_id
      where o.source = 'etsy'
        and o.status = any(${sql.raw(`ARRAY[${CANDIDATE_STATUSES.map((s) => `'${s}'`).join(",")}]`)}::order_status[])
        ${businessId ? sql`and o.business_id = ${businessId}` : sql``}
    `)) as unknown as ExecResult<Row>;

    const candidates = rows.rows as Row[];
    let toComplete = 0;
    let toCancel = 0;
    let unchanged = 0;
    const changes: { id: string; business: string; platformOrderId: string; from: string; to: string; etsyStatus: string | null }[] = [];

    for (const row of candidates) {
      const receipt = row.raw_import;
      if (!receipt || typeof receipt !== "object") {
        unchanged++;
        continue;
      }
      const next = etsyReceiptToInitialStatus(receipt);
      if (next === "awaiting_details") {
        unchanged++;
        continue;
      }
      if (next === "complete") toComplete++;
      else toCancel++;
      changes.push({
        id: row.id,
        business: row.business_name,
        platformOrderId: row.platform_order_id,
        from: row.status,
        to: next,
        etsyStatus: receipt.status ?? null,
      });
    }

    console.log(`candidates scanned: ${candidates.length}`);
    console.log(`  -> complete: ${toComplete}`);
    console.log(`  -> cancelled: ${toCancel}`);
    console.log(`  -> unchanged (still genuinely open per Etsy): ${unchanged}`);
    console.log("sample changes (up to 10):", JSON.stringify(changes.slice(0, 10), null, 2));

    if (!apply) {
      console.log("dry run only, nothing written. Re-run with --apply to write.");
      return;
    }

    for (const c of changes) {
      await tx.execute(sql`
        update orders set status = ${c.to}::order_status, updated_at = now()
        where id = ${c.id}
      `);
      await tx.execute(sql`
        insert into activity_log (id, business_id, order_id, actor_id, action, from_state, to_state, metadata)
        values (
          ${randomUUID()},
          (select business_id from orders where id = ${c.id}),
          ${c.id},
          null,
          'order.overdue_sweep_reconciled',
          ${c.from}::order_status,
          ${c.to}::order_status,
          jsonb_build_object('script', 'overdue-sweep', 'etsyStatus', ${c.etsyStatus}::text)
        )
      `);
    }
    console.log(`applied ${changes.length} status updates.`);

    const after = (await tx.execute(sql`
      select business_id, count(*) filter (
        where status not in ('shipped','delivered','complete','cancelled') and due_at < now()
      )::int as overdue
      from orders
      ${businessId ? sql`where business_id = ${businessId}` : sql``}
      group by business_id
    `)) as unknown as ExecResult<{ business_id: string; overdue: number }>;
    console.log("AFTER:", JSON.stringify(after.rows));
  });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
