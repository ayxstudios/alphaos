import { Card, EmptyState } from "@/components/ui";
import { Package } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default function OrdersPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-semibold text-ink">Orders</h1>
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
