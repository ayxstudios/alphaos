import { Card, EmptyState } from "@/components/ui";
import { Settings } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-2xl font-semibold text-ink">Settings</h1>
      <Card>
        <EmptyState
          icon={Settings}
          headline="Nothing to configure yet"
          body="Shop connections, SLA rules, and team management will live here."
        />
      </Card>
    </div>
  );
}
