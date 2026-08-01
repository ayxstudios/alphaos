import { Card, EmptyState } from "@/components/ui";
import { Grid } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-semibold text-ink">Dashboard</h1>
      <Card>
        <EmptyState
          icon={Grid}
          headline="Nothing to report yet"
          body="Order throughput, SLA risk, and designer load will appear here once orders start flowing."
        />
      </Card>
    </div>
  );
}
