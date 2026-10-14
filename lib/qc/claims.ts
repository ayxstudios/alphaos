import { and, eq, ne, sql } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { qcClaims, users } from "@/lib/db/schema";

/**
 * Two owners on /approve (Yousif 2026-10-14: "me and him can't really overlap
 * in our work or if we do it chooses the one that was first").
 *
 * The order on someone's Approve screen is theirs. Their screen claims it when
 * it opens and keeps the claim fresh while the page is visible; the other
 * owner's queue skips it, and a pass or fail from anyone else is refused while
 * the claim is fresh (confirmQcPassAndSend, prepareQcEmailPreview,
 * submitQcFail), so whoever opened it first decides it. Skip or closing the
 * page releases it; a claim nobody has refreshed for CLAIM_TTL_MS (a locked
 * phone, a dead tab) lapses on its own and the order is back in the pile.
 * Time is the database's own now(), so two servers never disagree.
 */
export const CLAIM_TTL_MS = 3 * 60_000;
/** How often an open Approve screen refreshes its claim (well inside the TTL). */
export const CLAIM_HEARTBEAT_MS = 30_000;

export type ClaimHolder = { holderId: string; holder: string };

/** POST /api/approve/claim's answer. */
export type ClaimAnswer =
  | { ok: true }
  | { ok: false; code: "claimed"; holder: string; message: string }
  | {
      ok: false;
      code: "stale" | "not_found" | "bad_request" | "auth" | "forbidden";
      message: string;
    };

// A constant, never user input: safe to inline.
const FRESH = sql`${qcClaims.seenAt} > now() - ${sql.raw(`interval '${CLAIM_TTL_MS / 1000} seconds'`)}`;

/** Their name, or the email's local part when the account has no name. */
export function holderName(row: {
  name: string | null;
  email: string | null;
}): string {
  const name = (row.name ?? "").trim();
  if (name) return name;
  return (row.email ?? "").split("@")[0] || "Someone";
}

/** What the refused person is told (toast title on the Approve screen). */
export function claimedMessage(holder: string): string {
  return `${holder} is already checking this one.`;
}

/** Another person's fresh claim on this order, or null (none, mine, or lapsed). */
export async function claimHolder(
  tx: Tx,
  orderId: string,
  userId: string,
): Promise<ClaimHolder | null> {
  const [row] = await tx
    .select({ holderId: qcClaims.userId, name: users.name, email: users.email })
    .from(qcClaims)
    .innerJoin(users, eq(users.id, qcClaims.userId))
    .where(
      and(eq(qcClaims.orderId, orderId), ne(qcClaims.userId, userId), FRESH),
    )
    .limit(1);
  return row ? { holderId: row.holderId, holder: holderName(row) } : null;
}

/**
 * Take or refresh my claim in one atomic statement: it lands only when the
 * order is unclaimed, already mine, or the other claim has lapsed. Otherwise
 * the current holder comes back.
 */
export async function takeClaim(
  tx: Tx,
  orderId: string,
  userId: string,
): Promise<{ ok: true } | ({ ok: false } & ClaimHolder)> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const won = await tx
      .insert(qcClaims)
      .values({ orderId, userId })
      .onConflictDoUpdate({
        target: qcClaims.orderId,
        set: {
          userId,
          // A fresh claim of mine keeps its start time; anything else starts now.
          claimedAt: sql`case when ${qcClaims.userId} = ${userId} and ${FRESH} then ${qcClaims.claimedAt} else now() end`,
          seenAt: sql`now()`,
        },
        setWhere: sql`${qcClaims.userId} = ${userId} or not (${FRESH})`,
      })
      .returning({ userId: qcClaims.userId });
    if (won.length) return { ok: true };
    const holder = await claimHolder(tx, orderId, userId);
    if (holder) return { ok: false, ...holder };
    // The other claim lapsed between the two statements: try once more.
  }
  return { ok: true };
}

/** Let go of my claim (Skip, page closed). Someone else's claim is never touched. */
export async function dropClaim(
  tx: Tx,
  orderId: string,
  userId: string,
): Promise<void> {
  await tx
    .delete(qcClaims)
    .where(and(eq(qcClaims.orderId, orderId), eq(qcClaims.userId, userId)));
}

/**
 * Fresh claims held by anyone else: kept out of my queue. Only live claims
 * match (a handful of rows at most, found through the seen_at index), so the
 * caller can run this alongside the queue query and intersect afterwards.
 */
export async function othersClaims(
  tx: Tx,
  userId: string,
): Promise<{ orderId: string; holderId: string; holder: string }[]> {
  const rows = await tx
    .select({
      orderId: qcClaims.orderId,
      holderId: qcClaims.userId,
      name: users.name,
      email: users.email,
    })
    .from(qcClaims)
    .innerJoin(users, eq(users.id, qcClaims.userId))
    .where(and(ne(qcClaims.userId, userId), FRESH));
  return rows.map((r) => ({
    orderId: r.orderId,
    holderId: r.holderId,
    holder: holderName(r),
  }));
}

/** "Ayser is checking 2": one line per other person with orders open. */
export function summarizeOthers(
  claims: { holderId: string; holder: string }[],
): { name: string; count: number }[] {
  const by = new Map<string, { name: string; count: number }>();
  for (const c of claims) {
    const cur = by.get(c.holderId);
    if (cur) cur.count++;
    else by.set(c.holderId, { name: c.holder, count: 1 });
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
