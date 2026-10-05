import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getDesignerRoster } from "@/lib/designers/roster";
import { getStyleCatalog } from "@/lib/designers/styles";
import { loadShellData } from "@/lib/shell/context";
import { AddDesigner } from "@/components/designers/add-designer";
import { DesignerRoster } from "@/components/designers/designer-roster";
import { TeamPanel } from "@/components/team/team-panel";
import { listTeam } from "@/lib/team/manage";
import { DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { Users } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default async function DesignersPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  // Staff-only surface; designers have no business here.
  if (user.role === "designer" || user.role === "helper") redirect("/board");

  const { selected, options } = await loadShellData(user);
  const isAdmin = user.role === "admin";
  const [designers, styleCatalog, team] = await Promise.all([
    getDesignerRoster(user, selected.id),
    getStyleCatalog(user, selected.id),
    isAdmin ? listTeam(user) : Promise.resolve([]),
  ]);

  return (
    <Page>
      <PageHeader
        title="Designers"
        tourId="page:roster"
        description="New orders go to the first designer on this list who draws the style and is under their daily limit."
        actions={
          designers.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              {isAdmin && (
                <Link href="/designers/capacity" className="inline-flex min-h-11 items-center text-sm font-medium text-pigment hover:underline lg:min-h-9">
                  Capacity
                </Link>
              )}
              <AddDesigner businesses={options} variant="secondary" />
            </div>
          ) : undefined
        }
      />

      {designers.length === 0 ? (
        <DataPanel>
          <EmptyState
            icon={Users}
            headline="No designers yet"
            body="Add a designer and their board, with the finished-portrait upload, appears right away."
            action={<AddDesigner businesses={options} />}
          />
        </DataPanel>
      ) : (
        <DesignerRoster designers={designers} styleOptions={styleCatalog} canEdit />
      )}

      {/* Admin only: add VAs and admins, deactivate, reset passwords. */}
      {isAdmin && <TeamPanel members={team} currentUserId={user.id} />}
    </Page>
  );
}
