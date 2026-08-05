import { notFound, redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { orders, shops, businesses, customers, orderItems, assets } from "@/lib/db/schema";
import { isR2Configured } from "@/lib/storage/r2";
import { NewOrderForm, type ExistingOrder } from "@/components/orders/new-order-form";
import { StatusChip } from "@/components/ui";
import type { OrderStatus } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CompleteOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");
  const { id } = await params;

  const [order] = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        shopId: orders.shopId,
        status: orders.status,
        platformOrderName: orders.platformOrderName,
        dueAt: orders.dueAt,
        placedAt: orders.placedAt,
        notes: orders.notes,
        rawImport: orders.rawImport,
        customerId: orders.customerId,
        shopName: shops.name,
        businessName: businesses.name,
      })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .innerJoin(businesses, eq(businesses.id, orders.businessId))
      .where(eq(orders.id, id)),
  );
  if (!order) notFound();
  // Only awaiting_details orders are completed here; anything else already has details.
  if (order.status !== "awaiting_details") redirect(`/orders/${id}`);

  let customerName = "";
  let customerEmail = "";
  if (order.customerId) {
    const [c] = await withUserContext(user, (tx) =>
      tx
        .select({ firstName: customers.firstName, lastName: customers.lastName, email: customers.email })
        .from(customers)
        .where(eq(customers.id, order.customerId!)),
    );
    if (c) {
      customerName = [c.firstName, c.lastName].filter(Boolean).join(" ");
      customerEmail = c.email ?? "";
    }
  }

  const [item] = await withUserContext(user, (tx) =>
    tx
      .select({
        title: orderItems.title,
        figureCount: orderItems.figureCount,
        style: orderItems.style,
        productType: orderItems.productType,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .limit(1),
  );
  const [photoCountRow] = await withUserContext(user, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(assets)
      .where(eq(assets.orderId, order.id)),
  );

  const existing: ExistingOrder = {
    orderId: order.id,
    shopId: order.shopId,
    shopLabel: `${order.businessName} — ${order.shopName}`,
    orderNumber: order.platformOrderName ?? "",
    status: order.status,
    customerName,
    customerEmail,
    dueAt: order.dueAt ? order.dueAt.toISOString().slice(0, 10) : "",
    dueAtIso: order.dueAt?.toISOString() ?? null,
    dueDateSource: "internal_sla",
    placedAtIso: order.placedAt?.toISOString() ?? null,
    savedProductTitle: item?.title ?? "",
    savedFigureCount: item?.figureCount ?? null,
    savedStyle: item?.style ?? "",
    savedProductType: item?.productType ?? null,
    savedNotes: order.notes ?? "",
    photoCount: photoCountRow?.count ?? 0,
    rawImport: order.rawImport,
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-2xl font-semibold text-ink">Complete order details</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate">
            <span className="font-medium text-ink">Etsy order {existing.orderNumber}</span>
            <span>{existing.shopLabel}</span>
          </div>
        </div>
        <StatusChip status={order.status as OrderStatus} />
      </div>
      <NewOrderForm shops={[]} r2Enabled={isR2Configured()} existing={existing} />
    </div>
  );
}
