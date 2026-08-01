import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { orders, orderItems } from "@/lib/db/schema";
import { loadShellData, ALL_BUSINESSES } from "@/lib/shell/context";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Badge } from "@/components/ui";
import { ListChecks } from "@/components/ui/icons";
import { ResolveFigureForm } from "@/components/queue/resolve-figure-form";

export const dynamic = "force-dynamic";

type Item = {
  id: string;
  variation: string | null;
  rawVariations: unknown;
  figureCount: number | null;
  figureCountSource: string | null;
  productType: string;
};

export default async function ReviewQueuePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const { selected } = await loadShellData(user);

  const { orderRows, itemsByOrder } = await withUserContext(user, async (tx) => {
    const orderRows = await (selected.id === ALL_BUSINESSES
      ? tx
          .select({ id: orders.id, platformOrderId: orders.platformOrderId, customerId: orders.customerId })
          .from(orders)
          .where(eq(orders.needsReview, true))
          .orderBy(orders.createdAt)
      : tx
          .select({ id: orders.id, platformOrderId: orders.platformOrderId, customerId: orders.customerId })
          .from(orders)
          .where(and(eq(orders.needsReview, true), eq(orders.businessId, selected.id)))
          .orderBy(orders.createdAt));

    const ids = orderRows.map((o) => o.id);
    const items: (Item & { orderId: string })[] = ids.length
      ? await tx
          .select({
            id: orderItems.id,
            orderId: orderItems.orderId,
            variation: orderItems.variation,
            rawVariations: orderItems.rawVariations,
            figureCount: orderItems.figureCount,
            figureCountSource: orderItems.figureCountSource,
            productType: orderItems.productType,
          })
          .from(orderItems)
          .where(inArray(orderItems.orderId, ids))
      : [];

    const itemsByOrder = new Map<string, Item[]>();
    for (const it of items) {
      const arr = itemsByOrder.get(it.orderId) ?? [];
      arr.push(it);
      itemsByOrder.set(it.orderId, arr);
    }
    return { orderRows, itemsByOrder };
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink">Review queue</h1>
        <p className="text-sm text-slate">
          Orders where the figure count couldn&apos;t be resolved automatically. Set it
          manually — this drives designer payout, so confirm against the variation.
        </p>
      </div>

      {orderRows.length === 0 ? (
        <Card>
          <EmptyState
            icon={ListChecks}
            headline="Nothing to review"
            body="Imported orders with an unresolved figure count will appear here."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {orderRows.map((o) => (
            <Card key={o.id}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>{o.platformOrderId}</CardTitle>
                  {!o.customerId && <Badge variant="warning">No buyer email</Badge>}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {(itemsByOrder.get(o.id) ?? []).map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col gap-2 rounded-input border border-line p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink">
                        {item.variation || "(no variation)"}
                      </span>
                      <Badge variant={item.productType === "digital" ? "info" : "neutral"}>
                        {item.productType}
                      </Badge>
                      {item.figureCountSource === "unresolved" ? (
                        <Badge variant="warning">unresolved</Badge>
                      ) : (
                        <Badge variant="success">
                          {item.figureCount} · {item.figureCountSource}
                        </Badge>
                      )}
                    </div>
                    <pre className="overflow-x-auto rounded-input bg-canvas p-2 text-xs text-slate">
                      {JSON.stringify(item.rawVariations, null, 2)}
                    </pre>
                    {item.figureCountSource === "unresolved" && (
                      <ResolveFigureForm orderItemId={item.id} />
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
