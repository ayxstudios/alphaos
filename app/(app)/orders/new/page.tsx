import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { shops } from "@/lib/db/schema";
import { loadShellData } from "@/lib/shell/context";
import { isR2Configured } from "@/lib/storage/r2";
import { NewOrderForm, type ShopOption } from "@/components/orders/new-order-form";
import { Page, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewOrderPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");
  const { selected } = await loadShellData(user);

  const rows = await withUserContext(user, (tx) =>
    tx
      .select({
        id: shops.id,
        name: shops.name,
        platform: shops.platform,
        slaConfig: shops.slaConfig,
        styles: shops.styles,
      })
      .from(shops)
      .where(and(eq(shops.active, true), eq(shops.businessId, selected.id)))
      .orderBy(shops.name),
  );

  const options: ShopOption[] = rows.map((r) => ({
    id: r.id,
    label: r.name,
    platform: r.platform,
    turnaroundDays:
      typeof (r.slaConfig as { turnaroundDays?: number } | null)?.turnaroundDays === "number"
        ? (r.slaConfig as { turnaroundDays: number }).turnaroundDays
        : 3,
    styles: r.styles ?? [],
  }));

  return (
    <Page>
      {/* Page's own max-width is the wide app width; a form reads best narrow. */}
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <PageHeader
          title="New order"
          description={`A manual order for ${selected.name}. Enter it once, then it flows like any other order.`}
        />
        <NewOrderForm shops={options} r2Enabled={isR2Configured()} />
      </div>
    </Page>
  );
}
