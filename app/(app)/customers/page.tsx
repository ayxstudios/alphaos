import { Card, EmptyState } from "@/components/ui";
import { Users } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default function CustomersPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-semibold text-ink">Customers</h1>
      <Card>
        <EmptyState
          icon={Users}
          headline="No customers yet"
          body="Customers, merged by email within each business, will appear here."
        />
      </Card>
    </div>
  );
}
