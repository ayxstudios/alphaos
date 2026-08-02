import { notFound, redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { messages, orders } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle, StatusChip, Badge } from "@/components/ui";
import type { OrderStatus } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const { id } = await params;

  // RLS scopes this: a designer only sees orders they are actively assigned.
  const [order] = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        platformOrderId: orders.platformOrderId,
        status: orders.status,
      })
      .from(orders)
      .where(eq(orders.id, id)),
  );

  if (!order) notFound();

  // Email timeline for this order: sent outbound + received inbound, newest last.
  // RLS scopes visibility (a designer sees only their assigned order's messages).
  const timeline = await withUserContext(user, (tx) =>
    tx
      .select({
        id: messages.id,
        direction: messages.direction,
        status: messages.status,
        subject: messages.subject,
        body: messages.body,
        address: messages.address,
        sentAt: messages.sentAt,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.orderId, id),
          eq(messages.channel, "email"),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(50),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-2xl font-semibold text-ink">
          {order.platformOrderId}
        </h1>
        <StatusChip status={order.status as OrderStatus} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Order detail</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate">
            Full order detail, assets, proofs, and activity will render here.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customer email</CardTitle>
        </CardHeader>
        <CardContent>
          {timeline.length === 0 ? (
            <p className="text-sm text-slate">No customer email on this order yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {timeline.map((m) => {
                const inbound = m.direction === "inbound";
                const when = m.sentAt ?? m.createdAt;
                return (
                  <li
                    key={m.id}
                    className={`rounded-card border border-line p-3 ${inbound ? "bg-pigment-soft/40" : "bg-canvas"}`}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <Badge variant={inbound ? "info" : "neutral"} dot>
                        {inbound ? "Reply from customer" : "Sent to customer"}
                      </Badge>
                      {!inbound && m.status !== "sent" && (
                        <Badge variant={m.status === "failed" ? "danger" : "warning"} dot>
                          {m.status}
                        </Badge>
                      )}
                      <span className="text-xs text-slate">
                        {when ? new Date(when).toLocaleString() : ""}
                      </span>
                    </div>
                    {m.subject && <p className="text-sm font-medium text-ink">{m.subject}</p>}
                    {m.body && (
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate line-clamp-6">{m.body}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
