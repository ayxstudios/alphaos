import { notFound, redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { messages, orders } from "@/lib/db/schema";
import {
  Badge,
  DataPanel,
  EmptyState,
  Page,
  PageHeader,
  SectionHeader,
  StatusChip,
  type OrderStatus,
} from "@/components/ui";
import { Inbox } from "@/components/ui/icons";

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

  const [order] = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        platformOrderId: orders.platformOrderId,
        platformOrderName: orders.platformOrderName,
        status: orders.status,
        dueAt: orders.dueAt,
        notes: orders.notes,
      })
      .from(orders)
      .where(eq(orders.id, id)),
  );

  if (!order) notFound();

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
      .where(and(eq(messages.orderId, id), eq(messages.channel, "email")))
      .orderBy(desc(messages.createdAt))
      .limit(50),
  );

  return (
    <Page>
      <PageHeader
        title={order.platformOrderName ?? order.platformOrderId}
        description={
          order.dueAt
            ? `Due ${new Intl.DateTimeFormat("en-AU", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              }).format(order.dueAt)}`
            : "No due date"
        }
        actions={<StatusChip status={order.status as OrderStatus} />}
      />

      <DataPanel className="p-4">
        <SectionHeader title="Order" />
        <p className="mt-3 text-sm text-slate">
          Full assets, proofs, and activity will appear here as the workflow
          expands.
        </p>
        {order.notes && (
          <p className="mt-3 rounded-input bg-canvas p-3 text-sm text-ink">
            {order.notes}
          </p>
        )}
      </DataPanel>

      <DataPanel className="overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <SectionHeader title="Customer email" />
        </div>
        {timeline.length === 0 ? (
          <EmptyState
            icon={Inbox}
            headline="No customer email yet"
            body="Messages sent from this order will appear here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {timeline.map((m) => {
              const inbound = m.direction === "inbound";
              const when = m.sentAt ?? m.createdAt;
              return (
                <li key={m.id} className="px-4 py-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant={inbound ? "info" : "neutral"} dot>
                      {inbound ? "Customer reply" : "Sent"}
                    </Badge>
                    {!inbound && m.status !== "sent" && (
                      <Badge
                        variant={m.status === "failed" ? "danger" : "warning"}
                        dot
                      >
                        {m.status}
                      </Badge>
                    )}
                    <span className="text-xs text-slate">
                      {when ? new Date(when).toLocaleString() : ""}
                    </span>
                  </div>
                  {m.subject && (
                    <p className="text-sm font-medium text-ink">{m.subject}</p>
                  )}
                  {m.body && (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate line-clamp-5">
                      {m.body}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DataPanel>
    </Page>
  );
}
