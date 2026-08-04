import Link from "next/link";

import { Card, EmptyState } from "@/components/ui";
import { Package } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default function OrdersPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-ink">Orders</h1>
        <Link
          href="/orders/new"
          className="inline-flex h-9 items-center rounded-input bg-pigment px-3 text-sm font-medium text-surface hover:opacity-90"
        >
          + New order
        </Link>
      </div>
      <Card>
        <EmptyState
          icon={Package}
          headline="No orders yet"
          body="Imported orders across every shop will be listed here, filtered by the active business."
        />
      </Card>
    </div>
  );
}
