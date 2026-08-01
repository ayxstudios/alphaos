import { Card, EmptyState } from "@/components/ui";
import { ListChecks } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default function QueuePage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-semibold text-ink">Queue</h1>
      <Card>
        <EmptyState
          icon={ListChecks}
          headline="Queue is clear"
          body="Orders awaiting QC and approval will line up here for VAs to work through."
        />
      </Card>
    </div>
  );
}
