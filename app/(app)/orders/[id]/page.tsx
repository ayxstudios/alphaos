import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle, StatusChip } from "@/components/ui";
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
    </div>
  );
}
