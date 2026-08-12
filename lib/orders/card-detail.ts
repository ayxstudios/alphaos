import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { activityLog, assets, orders, users } from "@/lib/db/schema";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import type { OrderStatus } from "./transitions";

/**
 * One row of the card's unified history feed. Everything the order has ever
 * logged — status transitions, proof views, imports — plus team comments, which
 * are stored as `activity_log` rows with `action = "comment"` and the text in
 * `metadata.body`. The feed is the Trello-style interleave of activity + chat.
 */
export type CardEvent = {
  id: string;
  action: string;
  actorId: string | null;
  /** Display name of the actor; null actor = system/automation. */
  actorName: string | null;
  fromState: OrderStatus | null;
  toState: OrderStatus | null;
  /** Present only on `action = "comment"` rows. */
  body: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string; // ISO
};

/** An order image resolved to a displayable URL for the modal gallery. */
export type CardImage = {
  id: string;
  type: "reference" | "submission" | "final";
  url: string;
  uploadedBy: string | null;
  createdAt: string;
};

export type CardDetail = {
  events: CardEvent[];
  images: CardImage[];
};

/**
 * Full modal payload for a single card: its history feed and all resolvable
 * images. Loaded lazily when a card is opened (not with the board), so the
 * board stays cheap. RLS scopes this exactly like the board — designers can
 * only read history/assets for orders assigned to them.
 */
export async function getCardDetail(user: RequestUser, orderId: string): Promise<CardDetail> {
  return withUserContext(user, async (tx) => {
    const rows = await tx
      .select({
        id: activityLog.id,
        action: activityLog.action,
        actorId: activityLog.actorId,
        actorName: users.name,
        fromState: activityLog.fromState,
        toState: activityLog.toState,
        metadata: activityLog.metadata,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .leftJoin(users, eq(users.id, activityLog.actorId))
      .where(eq(activityLog.orderId, orderId))
      .orderBy(asc(activityLog.createdAt));

    const events: CardEvent[] = rows.map((r) => {
      const meta = (r.metadata ?? null) as Record<string, unknown> | null;
      const body =
        r.action === "comment" && typeof meta?.body === "string" ? (meta.body as string) : null;
      return {
        id: r.id,
        action: r.action,
        actorId: r.actorId,
        actorName: r.actorName ?? null,
        fromState: r.fromState as OrderStatus | null,
        toState: r.toState as OrderStatus | null,
        body,
        metadata: meta,
        createdAt: r.createdAt.toISOString(),
      };
    });

    const imageRows = await tx
      .select({
        id: assets.id,
        type: assets.type,
        url: assets.url,
        storage: assets.storage,
        r2Key: assets.r2Key,
        createdAt: assets.createdAt,
        uploadedByName: users.name,
        uploadedByEmail: users.email,
      })
      .from(assets)
      .leftJoin(users, eq(users.id, assets.uploadedBy))
      .where(
        and(
          eq(assets.orderId, orderId),
          inArray(assets.type, ["reference", "submission", "final"]),
          isNull(assets.deletedAt),
        ),
      )
      .orderBy(asc(assets.createdAt));

    const r2Ok = isR2Configured();
    const images: CardImage[] = [];
    await Promise.all(
      imageRows.map(async (a) => {
        let url = a.url ?? null;
        if (!url && a.storage === "r2" && a.r2Key && r2Ok) {
          try {
            url = await presignGet(a.r2Key);
          } catch {
            /* skip an image we can't resolve rather than fail the modal */
          }
        }
        if (url) {
          images.push({
            id: a.id,
            type: a.type as CardImage["type"],
            url,
            uploadedBy: a.uploadedByName ?? a.uploadedByEmail ?? null,
            createdAt: a.createdAt.toISOString(),
          });
        }
      }),
    );

    return { events, images };
  });
}

/**
 * Append a team comment to an order's history. Comments live in `activity_log`
 * (append-only, RLS-scoped) so they interleave with status changes in one feed
 * and inherit the same immutability + tenant guarantees. Returns the new event
 * for optimistic append on the client.
 */
export async function addComment(
  user: RequestUser,
  orderId: string,
  body: string,
): Promise<CardEvent> {
  const text = body.trim();
  return withUserContext(user, async (tx) => {
    // Resolve the order's business_id (RLS still scopes what we can see) so the
    // activity row is tenant-tagged correctly.
    const [row] = await tx
      .select({ businessId: activityLog.businessId })
      .from(activityLog)
      .where(eq(activityLog.orderId, orderId))
      .limit(1);
    // Fall back to the orders table when the log is empty (rare — imports log a
    // row, but be safe).
    const businessId = row?.businessId ?? (await businessOf(tx, orderId));

    const [inserted] = await tx
      .insert(activityLog)
      .values({
        businessId,
        orderId,
        actorId: user.id,
        action: "comment",
        metadata: { body: text },
      })
      .returning({ id: activityLog.id, createdAt: activityLog.createdAt });

    const [me] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    return {
      id: inserted.id,
      action: "comment",
      actorId: user.id,
      actorName: me?.name ?? null,
      fromState: null,
      toState: null,
      body: text,
      metadata: { body: text },
      createdAt: inserted.createdAt.toISOString(),
    };
  });
}

type AnyTx = Parameters<Parameters<typeof withUserContext>[1]>[0];

async function businessOf(tx: AnyTx, orderId: string): Promise<string> {
  const [o] = await tx
    .select({ businessId: orders.businessId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!o) throw new Error(`Order ${orderId} not visible`);
  return o.businessId;
}
