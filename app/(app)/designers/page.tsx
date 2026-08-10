import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getDesignerRoster } from "@/lib/designers/roster";
import { getStyleCatalog } from "@/lib/designers/styles";
import { loadShellData, isAllBusinesses } from "@/lib/shell/context";
import { DesignerRoster } from "@/components/designers/designer-roster";
import { DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { Users } from "@/components/ui/icons";
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

  return (
    <Page>
      <PageHeader
        title="Designers"
        description="Rank designers, set daily limits and styles. Auto-assign walks this list top-down — a styled order only goes to a designer who does that style, and never past a designer's daily limit."
      />

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
