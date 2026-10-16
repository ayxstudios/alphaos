// What the staff to-do lists carry (Home tiles, Today, Messages "Reply needed",
// Awaiting QC, Print). Yousif 2026-10-03: only work from the business's to-do
// start date. Orders placed before it, and unlinked mail received before it,
// belong to the old process (Trello + the team's Gmail): they drop off the
// to-do lists but stay in All Orders and the mail history. The date is
// agent_config.todoFrom, falling back to agentFrom (the agent go-live); unset =
// no cutoff. Read in SQL like lib/agent/scope.ts so no config is passed around.
import { sql, type SQL } from "drizzle-orm";

import { messages, orders } from "@/lib/db/schema";

function todoFromFor(businessId: SQL | typeof orders.businessId | typeof messages.businessId): SQL {
  return sql`coalesce(
      (select coalesce(b.agent_config->>'todoFrom', b.agent_config->>'agentFrom')::timestamptz from businesses b where b.id = ${businessId}),
      '-infinity'::timestamptz
    )`;
}

// An URGENT order (lib/orders/urgent.ts) is on the to-do lists whatever its date:
// a buyer chasing an old order is today's work.
//
// So is artwork waiting for QC: a designer handed it in inside AlphaOS, so it is
// this process's work however old the order is. Ami Multani #CPS10282 and
// Audrea Sanchez 4196536586 (placed before CPS's to-do start) sat in
// awaiting_qc 61 h and 64 h because /approve never showed them (clean slating
// audit, 2026-10-16).
export function todoOrderScope(): SQL {
  return sql`(${orders.urgentAt} is not null or ${orders.status} = 'awaiting_qc' or coalesce(${orders.placedAt}, ${orders.createdAt}) >= ${todoFromFor(orders.businessId)})`;
}

export function todoMessageScope(): SQL {
  return sql`(${messages.createdAt} >= ${todoFromFor(messages.businessId)})`;
}
