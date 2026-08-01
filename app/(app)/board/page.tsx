import { Card, EmptyState } from "@/components/ui";
import { Columns } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default function BoardPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-semibold text-ink">Board</h1>
      <Card>
        <EmptyState
          icon={Columns}
          headline="Your board is empty"
          body="Orders assigned to you will appear here as cards, grouped by stage."
        />
      </Card>
    </div>
  );
}
