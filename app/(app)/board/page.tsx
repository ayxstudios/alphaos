import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getDesignerBoard } from "@/lib/orders/board-data";
import { DesignerBoard } from "@/components/board/designer-board";
import { DesignerPicker } from "@/components/board/designer-picker";
import { DataPanel, EmptyState, Page, PageHeader, StatCard } from "@/components/ui";
import { Columns } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const sp = await searchParams;
  const designerParam = typeof sp.designer === "string" ? sp.designer : undefined;
  const isStaff = user.role !== "designer";

  const listDesigners = () =>
    withUserContext(user, (tx) =>
      tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.role, "designer")),
    );

  // Staff must pick a designer first.
  if (isStaff && !designerParam) {
    const designers = await listDesigners();
    return (
      <Page>
        <PageHeader
          title="Designer boards"
          description="Select a designer to view assigned work and move cards through design."
          actions={
            <DesignerPicker
              designers={designers.map((d) => ({
                id: d.id,
                name: d.name ?? d.id,
              }))}
            />
          }
        />
        <DataPanel>
          <EmptyState
            icon={Columns}
            headline="Select a designer"
            body="Pick a designer to view and manage their board."
          />
        </DataPanel>
      </Page>
    );
  }

  // Designers can only ever see their own board.
  const targetId = isStaff ? designerParam! : user.id;
  const board = await getDesignerBoard(user, targetId);
  const designers = isStaff ? await listDesigners() : [];

  return (
    <Page className="max-w-none">
      <PageHeader
        title={isStaff ? "Designer board" : "My board"}
        description="Drag work from queue to design, then submit it for QC."
        actions={
          <>
          {isStaff && (
            <DesignerPicker
              designers={designers.map((d) => ({
                id: d.id,
                name: d.name ?? d.id,
              }))}
              current={targetId}
            />
          )}
            <div className="w-36">
              <StatCard
                label="Earned today"
                value={`$${board.dailyEarnings.toFixed(2)}`}
                tone="success"
              />
            </div>
          </>
        }
      />
      <DesignerBoard initial={board.columns} />
    </Page>
  );
}
