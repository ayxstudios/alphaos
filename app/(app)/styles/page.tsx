import { redirect } from "next/navigation";
import { and, asc, desc, eq, isNull, notInArray, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { loadShellData } from "@/lib/shell/context";
import { styles, designerProfiles, designerBusinesses, users, orderItems, orders, ignoredProducts } from "@/lib/db/schema";
import { Page, PageHeader } from "@/components/ui";
import { StylesManager, type StyleVM, type DesignerOption } from "@/components/styles/styles-manager";
import { UnrecognisedPanel, type UnrecognisedProduct, type IgnoredProduct } from "@/components/styles/unrecognised-panel";

// Statuses that are not portrait design work — a null style there is expected.
const NON_PORTRAIT_STATES = ["fulfillment_only", "triage", "cancelled"] as const;

export const dynamic = "force-dynamic";

export default async function StylesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const { selected } = await loadShellData(user);

  const { styleRows, designerRows, unrecognisedRows, ignoredRows } = await withUserContext(user, async (tx) => {
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

    const unrecognisedRows = await tx
      .select({
        title: orderItems.title,
        sku: orderItems.sku,
        orders: sql<number>`count(distinct ${orderItems.orderId})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orderItems.businessId, selected.id),
          isNull(orderItems.style),
          notInArray(orders.status, [...NON_PORTRAIT_STATES]),
        ),
      )
      .groupBy(orderItems.title, orderItems.sku)
      .orderBy(desc(sql`count(distinct ${orderItems.orderId})`));

    const ignoredRows = await tx
      .select({ id: ignoredProducts.id, title: ignoredProducts.title, sku: ignoredProducts.sku })
      .from(ignoredProducts)
      .where(eq(ignoredProducts.businessId, selected.id))
      .orderBy(desc(ignoredProducts.createdAt));

    return { styleRows, designerRows, unrecognisedRows, ignoredRows };
  });

  // A product is ignored by SKU when it has one, else by title.
  const ignoredSkus = new Set(ignoredRows.filter((r) => r.sku).map((r) => r.sku!.toLowerCase()));
  const ignoredTitles = new Set(ignoredRows.filter((r) => !r.sku && r.title).map((r) => r.title!.toLowerCase()));
  const unrecognised: UnrecognisedProduct[] = unrecognisedRows
    .filter((r) =>
      r.sku ? !ignoredSkus.has(r.sku.toLowerCase()) : !ignoredTitles.has((r.title ?? "").toLowerCase()),
    )
    .map((r) => ({ title: r.title, sku: r.sku, orders: Number(r.orders) }));
  const ignored: IgnoredProduct[] = ignoredRows.map((r) => ({ id: r.id, title: r.title, sku: r.sku }));

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
      <UnrecognisedPanel
        products={unrecognised}
        ignored={ignored}
        styles={styleList.map((s) => ({ id: s.id, name: s.name }))}
      />
      <StylesManager
        styles={styleList}
        designers={designers.map((d) => ({ id: d.id, name: d.name, styles: d.styles }))}
      />
    </Page>
  );
}
