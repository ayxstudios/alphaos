import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { shops, businesses } from "@/lib/db/schema";
import { isR2Configured } from "@/lib/storage/r2";
import { NewOrderForm, type ShopOption } from "@/components/orders/new-order-form";
import { Page, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewOrderPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const rows = await withUserContext(user, (tx) =>
    tx
      .select({
        id: shops.id,
        name: shops.name,
        platform: shops.platform,
        businessName: businesses.name,
        slaConfig: shops.slaConfig,
        styles: shops.styles,
      })
      .from(shops)
      .innerJoin(businesses, eq(businesses.id, shops.businessId))
      .where(eq(shops.active, true))
      .orderBy(businesses.name, shops.name),
  );

  const options: ShopOption[] = rows.map((r) => ({
    id: r.id,
    label: `${r.businessName} — ${r.name}`,
    platform: r.platform,
    turnaroundDays:
      typeof (r.slaConfig as { turnaroundDays?: number } | null)?.turnaroundDays === "number"
        ? (r.slaConfig as { turnaroundDays: number }).turnaroundDays
        : 3,
    styles: r.styles ?? [],
  }));

  return (
    <Page className="max-w-2xl">
      <PageHeader
        title="New order"
        description="Create a manual order without changing imported marketplace workflows."
      />
      <NewOrderForm shops={options} r2Enabled={isR2Configured()} />
    </Page>
  );
}
