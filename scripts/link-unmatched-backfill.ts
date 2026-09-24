/**
 * One-off: link inbound replies that arrived before subject matching existed.
 * Same rule as the poller (lib/email/link-reply.ts): a subject naming one of
 * the business's order numbers links to that order, and an order with no
 * customer adopts the sender. Suppressed and archived replies are left alone.
 *
 *   npx tsx scripts/link-unmatched-backfill.ts            # dry run, prints what would link
 *   npx tsx scripts/link-unmatched-backfill.ts --apply    # writes
 */
import "./load-env";

import { and, eq, isNull } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { activityLog, messages, orders } from "../lib/db/schema";
import { adoptSenderAsCustomer, matchOrderBySubject } from "../lib/email/link-reply";

const apply = process.argv.includes("--apply");

async function main() {
  const out = await withSystemContext(async (tx) => {
    const rows = await tx
      .select({ id: messages.id, businessId: messages.businessId, subject: messages.subject, address: messages.address })
      .from(messages)
      .where(and(eq(messages.direction, "inbound"), isNull(messages.orderId), isNull(messages.archivedAt), isNull(messages.suppressedAt)));
    const results: { subject: string | null; from: string | null; orderId: string | null; number: string | null; adopted: boolean }[] = [];
    for (const m of rows) {
      const match = await matchOrderBySubject(tx, m.businessId, m.subject);
      if (!match) {
        results.push({ subject: m.subject, from: m.address, orderId: null, number: null, adopted: false });
        continue;
      }
      const [o] = await tx.select({ number: orders.platformOrderName }).from(orders).where(eq(orders.id, match.orderId));
      let adopted = false;
      let customerId = match.customerId;
      if (apply) {
        const adoptedId = await adoptSenderAsCustomer(tx, { businessId: m.businessId, orderId: match.orderId, customerId: match.customerId, fromHeader: m.address });
        adopted = !match.customerId && !!adoptedId;
        customerId = adoptedId ?? match.customerId;
        await tx.update(messages).set({ orderId: match.orderId, customerId }).where(eq(messages.id, m.id));
        await tx.insert(activityLog).values({
          businessId: m.businessId,
          orderId: match.orderId,
          actorId: null,
          action: "message.received",
          metadata: { channel: "email", subject: m.subject, from: m.address, linkedBy: "subject", backfill: true },
        });
      } else {
        adopted = !match.customerId;
      }
      results.push({ subject: m.subject, from: m.address, orderId: match.orderId, number: o?.number ?? null, adopted });
    }
    return results;
  });
  for (const r of out) console.log(`${r.orderId ? "LINK " : "skip "} ${r.number ?? "-"}\t${r.adopted ? "adopt-sender" : "-"}\t${r.from}\t${r.subject}`);
  console.log(`${apply ? "applied" : "dry run"}: ${out.filter((r) => r.orderId).length} linked of ${out.length} unmatched`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
