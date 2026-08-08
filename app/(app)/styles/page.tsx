import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { loadShellData } from "@/lib/shell/context";
import { styles, designerProfiles, designerBusinesses, users } from "@/lib/db/schema";
import { Page, PageHeader } from "@/components/ui";
import { StylesManager, type StyleVM, type DesignerOption } from "@/components/styles/styles-manager";

export const dynamic = "force-dynamic";

export default async function StylesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const { selected } = await loadShellData(user);

  const { styleRows, designerRows } = await withUserContext(user, async (tx) => {
    const styleRows = await tx
      .select({
        id: styles.id,
        name: styles.name,
        titleMatches: styles.titleMatches,
        isDefault: styles.isDefault,
      })
      .from(styles)
      .where(eq(styles.businessId, selected.id))
      .orderBy(asc(styles.name));

    const designerRows = await tx
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        styles: designerProfiles.styles,
      })
      .from(designerProfiles)
      .innerJoin(users, and(eq(users.id, designerProfiles.userId), eq(users.active, true), eq(users.role, "designer")))
      .innerJoin(
        designerBusinesses,
        and(eq(designerBusinesses.userId, users.id), eq(designerBusinesses.businessId, selected.id)),
      )
      .orderBy(asc(users.name), asc(users.email));

    return { styleRows, designerRows };
  });

  const designers: DesignerOption[] = designerRows.map((d) => ({
    id: d.id,
    name: d.name ?? d.email,
    styles: (d.styles ?? []).map((s) => s.toLowerCase()),
  }));

  const styleList: StyleVM[] = styleRows.map((s) => ({
    id: s.id,
    name: s.name,
    titleMatches: s.titleMatches ?? [],
    isDefault: s.isDefault,
    designerIds: designers.filter((d) => d.styles.includes(s.name.toLowerCase())).map((d) => d.id),
  }));

  return (
    <Page>
      <PageHeader
        title="Portrait Styles"
        description="The styles this workspace sells and the rules that auto-assign an order to a style. An order is tagged with the first style whose title rule matches the product name (or the default style). A designer only receives orders in the styles you give them here."
      />
      <StylesManager
        styles={styleList}
        designers={designers.map((d) => ({ id: d.id, name: d.name, styles: d.styles }))}
      />
    </Page>
  );
}
