import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getDesignerRoster } from "@/lib/designers/roster";
import { getStyleCatalog } from "@/lib/designers/styles";
import { loadShellData, isAllBusinesses } from "@/lib/shell/context";
import { DesignerRoster } from "@/components/designers/designer-roster";
import { DataPanel, EmptyState, Page, PageHeader, StatCard } from "@/components/ui";
import { Grid, Inbox, ListChecks, Users } from "@/components/ui/icons";
import { PickBusinessPrompt } from "@/components/shell/pick-business-prompt";

export const dynamic = "force-dynamic";

export default async function DesignersPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  // Staff-only surface; designers have no business here.
  if (user.role === "designer") redirect("/board");

  const { selected } = await loadShellData(user);
  if (isAllBusinesses(selected.id)) return <PickBusinessPrompt title="Designers" />;
  const [designers, styleCatalog] = await Promise.all([
    getDesignerRoster(user),
    getStyleCatalog(user, selected.id),
  ]);

  const assignedToday = designers.reduce((sum, d) => sum + d.assignedToday, 0);
  const totalCapacity = designers.reduce((sum, d) => sum + d.dailyCapacity, 0);
  const wipTotal = designers.reduce((sum, d) => sum + d.wipCount, 0);
  const atCapacity = designers.filter(
    (d) => d.dailyCapacity > 0 && d.assignedToday >= d.dailyCapacity,
  ).length;

  return (
    <Page>
      <PageHeader
        title="Designers"
        description="Rank designers, set daily limits and styles. Auto-assign walks this list top-down — a styled order only goes to a designer who does that style, and never past a designer's daily limit."
      />

      {designers.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Active designers" value={designers.length} icon={<Users size={16} />} />
          <StatCard
            label="Assigned today"
            value={`${assignedToday} / ${totalCapacity}`}
            detail="Roster-wide, against daily limits"
            icon={<Grid size={16} />}
          />
          <StatCard
            label="In flight"
            value={wipTotal}
            detail="In design or awaiting QC"
            tone="info"
            icon={<ListChecks size={16} />}
          />
          <StatCard
            label="At capacity"
            value={atCapacity}
            tone={atCapacity > 0 ? "warning" : "neutral"}
            detail={atCapacity > 0 ? "Skip these for new work" : "Everyone has headroom"}
            icon={<Inbox size={16} />}
          />
        </div>
      )}

      {designers.length === 0 ? (
        <DataPanel>
          <EmptyState
            icon={Users}
            headline="No designers yet"
            body="Active designers with a profile will appear here to rank and configure."
          />
        </DataPanel>
      ) : (
        <DesignerRoster designers={designers} styleOptions={styleCatalog} canEdit />
      )}
    </Page>
  );
}
