import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import {
  assets,
  customers,
  orderItems,
  orders,
  printJobs,
  shops,
} from "@/lib/db/schema";
import { loadShellData } from "@/lib/shell/context";
import { defaultPrintProvider } from "@/lib/print/mapping";
import { isR2Configured, presignGet } from "@/lib/storage/r2";
import { EmptyState, Page, PageHeader } from "@/components/ui";
import { Printer } from "@/components/ui/icons";
import { PrintQueue, type PrintQueueItemVM } from "@/components/print/print-queue";

export const dynamic = "force-dynamic";

type OrderRow = {
  id: string;
  orderNumber: string | null;
  fallbackNumber: string;
  source: "etsy" | "shopify" | "manual";
  status: string;
  placedAt: Date | null;
  shopName: string;
  customerFirst: string | null;
  customerLast: string | null;
};

function customerName(row: OrderRow): string {
  return [row.customerFirst, row.customerLast].filter(Boolean).join(" ") || "Unknown customer";
}

async function resolveAssetUrl(row: {
  url: string | null;
  storage: string;
  r2Key: string | null;
}): Promise<string | null> {
  if (row.url) return row.url;
  if (row.storage === "r2" && row.r2Key && isR2Configured()) {
    try {
      return await presignGet(row.r2Key);
    } catch {
      return null;
    }
  }
  return null;
}

export default async function PrintQueuePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role !== "admin" && user.role !== "va") {
    return (
      <Page>
        <PageHeader title="Ready to Print" description="Physical fulfilment is managed by staff." />
        <EmptyState icon={Printer} headline="Staff only" body="Ask a VA or admin to manage print fulfilment." />
      </Page>
    );
  }

  const { selected } = await loadShellData(user);
  const orderRows = await withUserContext(user, (tx) =>
    tx
      .select({
        id: orders.id,
        orderNumber: orders.platformOrderName,
        fallbackNumber: orders.platformOrderId,
        source: orders.source,
        status: orders.status,
        placedAt: orders.placedAt,
        shopName: shops.name,
        customerFirst: customers.firstName,
        customerLast: customers.lastName,
      })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(
        and(
          eq(orders.businessId, selected.id),
          isNull(orders.archivedAt),
          inArray(orders.status, ["approved", "printing"]),
        ),
      )
      .orderBy(sql`${orders.placedAt} asc nulls last`, asc(orders.createdAt)),
  );

  const orderIds = orderRows.map((order) => order.id);
  const itemRows = orderIds.length
    ? await withUserContext(user, (tx) =>
        tx
          .select({
            orderId: orderItems.orderId,
            productType: orderItems.productType,
          })
          .from(orderItems)
          .where(inArray(orderItems.orderId, orderIds)),
      )
    : [];
  const physicalByOrder = new Map<string, typeof itemRows>();
  for (const item of itemRows) {
    if (item.productType !== "physical") continue;
    const list = physicalByOrder.get(item.orderId) ?? [];
    list.push(item);
    physicalByOrder.set(item.orderId, list);
  }

  const visibleRows = orderRows.filter((order) => (physicalByOrder.get(order.id)?.length ?? 0) > 0);
  const visibleIds = visibleRows.map((order) => order.id);

  const [assetRows, printRows] = visibleIds.length
    ? await Promise.all([
        withUserContext(user, (tx) =>
          tx
            .select({
              id: assets.id,
              orderId: assets.orderId,
              type: assets.type,
              url: assets.url,
              storage: assets.storage,
              r2Key: assets.r2Key,
            })
            .from(assets)
            .where(and(inArray(assets.orderId, visibleIds), inArray(assets.type, ["final", "submission"]), isNull(assets.deletedAt)))
            .orderBy(desc(assets.createdAt)),
        ),
        withUserContext(user, (tx) =>
          tx
            .select({
              orderId: printJobs.orderId,
              provider: printJobs.provider,
              status: printJobs.status,
              trackingNumber: printJobs.trackingNumber,
              platformSyncError: printJobs.platformSyncError,
              createdAt: printJobs.createdAt,
            })
            .from(printJobs)
            .where(inArray(printJobs.orderId, visibleIds))
            .orderBy(desc(printJobs.createdAt)),
        ),
      ])
    : [[], []];

  const latestPrint = new Map<string, (typeof printRows)[number]>();
  for (const row of printRows) if (!latestPrint.has(row.orderId)) latestPrint.set(row.orderId, row);

  const assetByOrder = new Map<string, (typeof assetRows)[number]>();
  for (const asset of assetRows) {
    const current = assetByOrder.get(asset.orderId);
    if (!current || (asset.type === "final" && current.type !== "final")) assetByOrder.set(asset.orderId, asset);
  }
  const assetUrls = new Map<string, string | null>();
  await Promise.all(
    [...assetByOrder.entries()].map(async ([orderId, asset]) => {
      assetUrls.set(orderId, await resolveAssetUrl(asset));
    }),
  );

  const vm: PrintQueueItemVM[] = visibleRows.map((order) => {
    const latestJob = latestPrint.get(order.id);
    return {
      id: order.id,
      orderNumber: order.orderNumber ?? order.fallbackNumber,
      source: order.source,
      status: order.status,
      shopName: order.shopName,
      customerName: customerName(order),
      placedAt: order.placedAt ? order.placedAt.toISOString() : null,
      artworkUrl: assetUrls.get(order.id) ?? null,
      defaultProvider: latestJob?.provider ?? defaultPrintProvider(null),
      latestPrintJob: latestJob
        ? {
            provider: latestJob.provider,
            status: latestJob.status,
            trackingNumber: latestJob.trackingNumber,
            platformSyncError: latestJob.platformSyncError,
          }
        : null,
    };
  });

  return (
    <Page>
      <PageHeader
        title="Ready to Print"
        description="Approved physical orders that need a VA to trigger printing in the provider dashboard."
      />
      <PrintQueue orders={vm} />
    </Page>
  );
}
