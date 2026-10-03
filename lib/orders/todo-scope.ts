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

export function todoOrderScope(): SQL {
  return sql`(coalesce(${orders.placedAt}, ${orders.createdAt}) >= ${todoFromFor(orders.businessId)})`;
}

export function todoMessageScope(): SQL {
  return sql`(${messages.createdAt} >= ${todoFromFor(messages.businessId)})`;
}
