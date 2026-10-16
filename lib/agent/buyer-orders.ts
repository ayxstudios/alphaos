// The reply agent's view of "this buyer has more than one order" (incident 16
// Oct 2026: an email on one order's thread can be about another order). One
// short read of the buyer's other orders, turned into the block both reply
// prompts carry (the classifier and the answer draft), plus the timeline note
// written on a sibling order when a reply names it. Reads never throw: a failed
// lookup means the prompts go out without the block, exactly as before.
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog } from "@/lib/db/schema";
import {
  buyerOrdersPromptBlock,
  loadSameBuyerContext,
  type SameBuyerContext,
  type SameBuyerOrder,
} from "@/lib/orders/same-buyer";

/** Runs a read in the caller's database context: withSystemContext in jobs, withUserContext for a signed-in user. */
export type ContextRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export type BuyerOrdersForReply = {
  context: SameBuyerContext;
  /** Prompt block: this order, the buyer's other orders (number, product line, stage) and the rule. Never empty. */
  block: string;
};

/**
 * The buyer's other orders for a reply on `orderId`, with the prompt block for
 * them. Null when the buyer has no other order or the lookup failed.
 */
export async function buyerOrdersForReply(
  run: ContextRunner,
  orderId: string,
  load: typeof loadSameBuyerContext = loadSameBuyerContext,
): Promise<BuyerOrdersForReply | null> {
  try {
    const context = await run((tx) => load(tx, orderId, { staff: true, artwork: false }));
    if (!context || context.others.length === 0) return null;
    return { context, block: buyerOrdersPromptBlock(context.thisOrder, context.others) };
  } catch (err) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "reply_same_buyer_failed",
        orderId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/** The activity_log action a reply leaves on another order of the same buyer (the existing timeline entry for a message). */
export const MENTION_ACTION = "message.received";

/** Metadata of that row: which order's thread the reply came in on and which message it was. */
export function mentionNoteMetadata(from: { id: string; number: string }, messageId: string): Record<string, unknown> {
  return { linkedBy: "mention", fromOrderId: from.id, fromOrderNumber: from.number, messageId };
}

/** Order numbers as one phrase for a person: "PC32131", "PC32131 and #CPS10282", "A, B and C". */
export function orderNumbersPhrase(numbers: string[]): string {
  if (numbers.length <= 1) return numbers.join("");
  return `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}

/** The line a human reads on a reply that names another of the buyer's orders. */
export function namedOrdersAdvice(named: SameBuyerOrder[]): string {
  const phrase = orderNumbersPhrase(named.map((o) => o.number));
  return `The reply names ${phrase}, another order of this buyer. Check which order and product they mean before answering or approving.`;
}

/**
 * Leave a "message.received" row (linkedBy "mention") on each of the buyer's
 * OTHER orders that a reply names, so that order's timeline shows the buyer
 * wrote about it. Each row runs in its own savepoint, so a failed read or insert
 * never aborts the caller's transaction, and a row for the same message is never
 * written twice. Returns how many rows were written.
 */
export async function noteMentionedOrders(
  tx: Tx,
  input: { businessId: string; messageId: string; from: { id: string; number: string }; mentioned: SameBuyerOrder[] },
): Promise<number> {
  let written = 0;
  for (const other of input.mentioned) {
    const otherId = other.id;
    if (!otherId || otherId === input.from.id) continue;
    try {
      const wrote = await tx.transaction(async (sp) => {
        const [existing] = await sp
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.orderId, otherId),
              eq(activityLog.action, MENTION_ACTION),
              sql`${activityLog.metadata}->>'linkedBy' = 'mention'`,
              sql`${activityLog.metadata}->>'messageId' = ${input.messageId}`,
            ),
          )
          .limit(1);
        if (existing) return false;
        await sp.insert(activityLog).values({
          businessId: input.businessId,
          orderId: otherId,
          actorId: null,
          action: MENTION_ACTION,
          metadata: mentionNoteMetadata(input.from, input.messageId),
        });
        return true;
      });
      if (wrote) written += 1;
    } catch (err) {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          event: "reply_mention_note_failed",
          orderId: otherId,
          messageId: input.messageId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return written;
}
