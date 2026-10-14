import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import {
  claimedMessage,
  dropClaim,
  takeClaim,
  type ClaimAnswer,
} from "@/lib/qc/claims";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Approve screen's hold on the order it shows (lib/qc/claims.ts, Yousif
 * 2026-10-14: two owners never on the same order, first one wins).
 * op "claim" takes or refreshes it (on open, then every CLAIM_HEARTBEAT_MS
 * while visible); op "release" lets go (Skip, page closed; sent with
 * keepalive). A plain route, not a server action, so a page older than the
 * live deployment keeps its claim and a closing page can still release it.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    orderId?: unknown;
    op?: unknown;
  } | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  const op =
    body?.op === "release" ? "release" : body?.op === "claim" ? "claim" : null;
  if (!/^[0-9a-f-]{36}$/i.test(orderId) || !op) {
    return NextResponse.json(
      {
        ok: false,
        code: "bad_request",
        message: "Missing order.",
      } satisfies ClaimAnswer,
      { status: 400 },
    );
  }
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json(
      {
        ok: false,
        code: "auth",
        message: "Please sign in again.",
      } satisfies ClaimAnswer,
      { status: 401 },
    );
  }
  const role = session.user.role;
  if (role !== "admin" && role !== "va") {
    return NextResponse.json(
      {
        ok: false,
        code: "forbidden",
        message: "Only staff can approve artwork.",
      } satisfies ClaimAnswer,
      { status: 403 },
    );
  }
  const user = { id: session.user.id, role };

  const answer = await withUserContext(
    user,
    async (tx): Promise<ClaimAnswer> => {
      if (op === "release") {
        await dropClaim(tx, orderId, user.id);
        return { ok: true };
      }
      const [o] = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, orderId));
      if (!o)
        return {
          ok: false,
          code: "not_found",
          message: "This order could not be found.",
        };
      if (o.status !== "awaiting_qc")
        return {
          ok: false,
          code: "stale",
          message: "This one was already checked.",
        };
      const res = await takeClaim(tx, orderId, user.id);
      return res.ok
        ? { ok: true }
        : {
            ok: false,
            code: "claimed",
            holder: res.holder,
            message: claimedMessage(res.holder),
          };
    },
  );
  return NextResponse.json(answer);
}
