import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getDesignerRoster } from "@/lib/designers/roster";
import { getStyleCatalog } from "@/lib/designers/styles";
import { loadShellData } from "@/lib/shell/context";
import { AddDesigner } from "@/components/designers/add-designer";
import { DesignerRoster } from "@/components/designers/designer-roster";
import { DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { Users } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default async function DesignersPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  // Staff-only surface; designers have no business here.
  if (user.role === "designer") redirect("/board");

  const { selected, options } = await loadShellData(user);
  const isAdmin = user.role === "admin";
  const [designers, styleCatalog] = await Promise.all([
    getDesignerRoster(user),
    getStyleCatalog(user, selected.id),
  ]);

  return (
    <Page>
      <PageHeader
        title="Designers"
        description="Auto-assign works down this list, matching styles and never past a daily limit."
        actions={isAdmin && designers.length > 0 ? <AddDesigner businesses={options} variant="secondary" /> : undefined}
      />

      {designers.length === 0 ? (
        <DataPanel>
          <EmptyState
            icon={Users}
            headline="No designers yet"
            body={
              isAdmin
                ? "Add a designer and their board, with the finished-portrait upload, appears right away."
                : "Ask an admin to add designers; they appear here to rank and configure."
            }
            action={isAdmin ? <AddDesigner businesses={options} /> : undefined}
          />
        </DataPanel>
      ) : (
        <DesignerRoster designers={designers} styleOptions={styleCatalog} canEdit />
      )}
    </Page>
  );
}
