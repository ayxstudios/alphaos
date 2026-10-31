/**
 * One-off heal (2026-10-31): print and ship orders the reminders sweep approved on
 * silence (the old day-7 auto-approve, removed the same day) go back to waiting for
 * the customer. Yousif 2026-10-31: "Even print and ship orders shouldn't go out
 * without final approval from the customer."
 *
 * Only an order still `approved` whose approval came from `reminders_sweep_silence`,
 * with nothing at the printer, is touched; one where the buyer wrote after the proof
 * is listed for a person instead. For each: the latest proof's decision is cleared,
 * the order is back in awaiting_approval with a timeline row (there is no
 * approved -> awaiting_approval edge, so this is a direct write), the print
 * reconcile placeholder rows (no provider order) are removed and their queued
 * "missed print" alerts skipped. Digital orders are left alone: for them going
 * ahead on silence is still the rule.
 *
 * Usage: DATABASE_URL=<owner url> tsx scripts/heal-silence-approvals.ts [--apply]
 * --apply writes var-heal-silence-approvals-undo-<ts>.json first.
 */
import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";
import fs from "node:fs";

const REASON =
  "Approved on silence by the old 7-day rule. Yousif 2026-10-31: print and ship orders never go out without the customer's own approval.";

// Same rule as lib/reminders/print-ship.ts printShipWhere().
const PRINT_SHIP = `(exists (select 1 from order_items oi where oi.order_id = o.id and oi.product_type = 'physical')
  or exists (select 1 from jsonb_array_elements(case jsonb_typeof(o.raw_import->'transactions') when 'array' then o.raw_import->'transactions' else '[]'::jsonb end) t
    where t->>'listing_id' = '1231801819' or coalesce(t->>'title', '') ~* '^[[:space:]]*print[[:space:]]*(&amp;|&|and|[+])[[:space:]]*ship'))`;

type Candidate = {
  id: string;
  business_id: string;
  platform_order_name: string | null;
  platform_order_id: string;
  approved_at: string;
  proof_id: string;
  decision: string | null;
  decided_at: string | null;
  buyer_wrote: boolean;
};
type PrintJobRow = Record<string, unknown> & { id: string; order_id: string };
type AlertRow = { id: string; order_id: string; status: string };

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const apply = process.argv.includes("--apply");
  const rows = (await sql.query(
    `select o.id, o.business_id, o.platform_order_name, o.platform_order_id, o.status, a.created_at approved_at,
            p.id proof_id, p.decision, p.decided_at, coalesce(p.sent_at, p.created_at) proof_at,
            exists (select 1 from messages m where m.order_id = o.id and m.direction = 'inbound' and m.suppressed_at is null
                      and (m.channel = 'email' or (m.channel = 'etsy' and m.metadata->>'kind' = 'message'))
                      and m.created_at > coalesce(p.sent_at, p.created_at)) buyer_wrote
       from orders o
       join lateral (select created_at, metadata from activity_log x where x.order_id = o.id and x.action = 'order.approved'
                      order by x.created_at desc limit 1) a on true
       join lateral (select * from proofs y where y.order_id = o.id order by y.created_at desc limit 1) p on true
      where o.status = 'approved' and o.archived_at is null
        and a.metadata->>'via' = 'reminders_sweep_silence'
        and ${PRINT_SHIP}
        and not exists (select 1 from print_jobs pj where pj.order_id = o.id and pj.provider_order_id is not null)`,
  )) as Candidate[];
  const heal = rows.filter((r) => !r.buyer_wrote && r.decision === "approved");
  const forAPerson = rows.filter((r) => !heal.includes(r));
  const placeholders = (heal.length
    ? await sql.query(
        `select * from print_jobs where order_id = any($1::text[]) and provider_order_id is null and status is null
            and provider_payload->>'source' = 'print_reconcile_placeholder'`,
        [heal.map((r) => r.id)],
      )
    : []) as PrintJobRow[];
  const alerts = (heal.length
    ? await sql.query(
        `select id, order_id, status from alpha_events where order_id = any($1::text[]) and type = 'order.missed_print'
            and status in ('queued', 'failed')`,
        [heal.map((r) => r.id)],
      )
    : []) as AlertRow[];
  const name = (r: Candidate) => r.platform_order_name ?? r.platform_order_id;
  console.log({
    heal: heal.map((r) => ({ order: name(r), approvedAt: r.approved_at, proofId: r.proof_id })),
    placeholderPrintJobs: placeholders.map((p) => p.id),
    missedPrintAlerts: alerts.map((a) => a.id),
    forAPerson: forAPerson.map((r) => ({ order: name(r), why: r.buyer_wrote ? "the buyer wrote after the proof" : `proof is ${r.decision ?? "undecided"}` })),
  });
  if (!apply || !heal.length) return;

  const undoFile = `var-heal-silence-approvals-undo-${Date.now()}.json`;
  fs.writeFileSync(
    undoFile,
    JSON.stringify({ orders: heal.map((r) => ({ id: r.id, proofId: r.proof_id, decidedAt: r.decided_at })), printJobs: placeholders, alerts }, null, 2),
  );
  console.log("undo file", undoFile);

  for (const r of heal) {
    const removed = placeholders.filter((p) => p.order_id === r.id).map((p) => p.id);
    const skipped = alerts.filter((a) => a.order_id === r.id).map((a) => a.id);
    // One transaction; every later step only runs if the order really moved back
    // (an order someone moved since the scan is left exactly as it is).
    const back = `exists (select 1 from orders where id = '${r.id.replace(/'/g, "")}' and status = 'awaiting_approval')`;
    const res = await sql.transaction([
      sql.query(`update orders set status = 'awaiting_approval', updated_at = now() where id = $1 and status = 'approved' returning id`, [r.id]),
      sql.query(`update proofs set decision = null, decided_at = null where id = $1 and decision = 'approved' and ${back} returning id`, [r.proof_id]),
      sql.query(`delete from print_jobs where id = any($1::text[]) and provider_order_id is null and ${back} returning id`, [removed]),
      sql.query(`update alpha_events set status = 'skipped', error = $2 where id = any($1::text[]) and status in ('queued', 'failed') and ${back} returning id`, [
        skipped,
        "The order is back to waiting for the customer's approval; nothing is printed until she approves.",
      ]),
      sql.query(
        `insert into activity_log (id, business_id, order_id, actor_id, action, from_state, to_state, metadata)
         select $1, $2, $3, null, 'order.awaiting_approval', 'approved', 'awaiting_approval', $4::jsonb where ${back} returning id`,
        [crypto.randomUUID(), r.business_id, r.id, JSON.stringify({ via: "heal_silence_approval", reason: REASON, proofId: r.proof_id, removedPrintJobs: removed, skippedAlerts: skipped })],
      ),
    ]);
    console.log(name(r), {
      order: res[0].length,
      proof: res[1].length,
      printJobsRemoved: res[2].length,
      alertsSkipped: res[3].length,
      timeline: res[4].length,
    });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
