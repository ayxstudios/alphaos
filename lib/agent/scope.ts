// Which orders the agent (and the automatic reminders) may touch at all.
// Orders that came over from Trello stay with the team on Trello, and orders
// placed before the business's go-live cutoff (agentConfig.agentFrom) belong
// to the old process. Read straight from the business row in SQL so every
// query can add it without passing config around; an unset cutoff = no cutoff.
import { sql, type SQL } from "drizzle-orm";

import { messages, orders } from "@/lib/db/schema";

// An order marked URGENT (lib/orders/urgent.ts: a buyer is chasing it, legacy
// or not) is always in scope, so the agent works it whatever its origin.
export function agentOrderScope(): SQL {
  return sql`(${orders.urgentAt} is not null or (${orders.source} not in ('legacy', 'trello')
    and ${orders.trelloCardId} is null
    and coalesce(${orders.placedAt}, ${orders.createdAt}) >= coalesce(
      (select (b.agent_config->>'agentFrom')::timestamptz from businesses b where b.id = ${orders.businessId}),
      '-infinity'::timestamptz
    )))`;
}

/**
 * Outbound mail the agent may send by itself: written on/after the go-live
 * cutoff, and either not about an order or about an order inside
 * agentOrderScope. Anything older stays where it is for a human.
 */
export function agentMessageScope(): SQL {
  return sql`(${messages.createdAt} >= coalesce(
      (select (b.agent_config->>'agentFrom')::timestamptz from businesses b where b.id = ${messages.businessId}),
      '-infinity'::timestamptz
    )
    and (${messages.orderId} is null or ${messages.orderId} in (select ${orders.id} from ${orders} where ${agentOrderScope()})))`;
}
