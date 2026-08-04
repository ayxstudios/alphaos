import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { shops, businesses } from "@/lib/db/schema";
import { isR2Configured } from "@/lib/storage/r2";
import { NewOrderForm, type ShopOption } from "@/components/orders/new-order-form";

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
  }));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="font-display text-2xl font-semibold text-ink">New order</h1>
      <NewOrderForm shops={options} r2Enabled={isR2Configured()} />
    </div>
  );
}
