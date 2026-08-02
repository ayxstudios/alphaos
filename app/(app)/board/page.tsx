import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getDesignerBoard } from "@/lib/orders/board-data";
import { DesignerBoard } from "@/components/board/designer-board";
import { DesignerPicker } from "@/components/board/designer-picker";
import { Card, EmptyState } from "@/components/ui";
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
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-2xl font-semibold text-ink">Designer boards</h1>
        <DesignerPicker designers={designers.map((d) => ({ id: d.id, name: d.name ?? d.id }))} />
        <Card>
          <EmptyState
            icon={Columns}
            headline="Select a designer"
            body="Pick a designer to view and manage their board."
          />
        </Card>
      </div>
    );
  }

  // Designers can only ever see their own board.
  const targetId = isStaff ? designerParam! : user.id;
  const board = await getDesignerBoard(user, targetId);
  const designers = isStaff ? await listDesigners() : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-2xl font-semibold text-ink">
          {isStaff ? "Designer board" : "My board"}
        </h1>
        <div className="flex items-center gap-4">
          {isStaff && (
            <DesignerPicker
              designers={designers.map((d) => ({ id: d.id, name: d.name ?? d.id }))}
              current={targetId}
            />
          )}
          <div className="rounded-card border border-line bg-surface px-3 py-1.5 text-right">
            <div className="text-xs text-slate">Earned today</div>
            <div className="text-sm font-semibold text-sage">${board.dailyEarnings.toFixed(2)}</div>
          </div>
        </div>
      </div>
      <DesignerBoard initial={board.columns} />
    </div>
  );
}
