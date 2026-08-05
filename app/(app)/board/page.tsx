import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getDesignerBoard } from "@/lib/orders/board-data";
import { getRailDesigners } from "@/lib/designers/roster";
import { DesignerBoard } from "@/components/board/designer-board";
import { DesignerPicker } from "@/components/board/designer-picker";
import { DesignerRail } from "@/components/board/designer-rail";
import { EmptyState, Page, PageHeader, StatCard } from "@/components/ui";
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

  // Designers can only ever see their own board; staff pick one from the
  // right-hand rail (app shell) or the mobile dropdown below.
  const targetId = isStaff ? designerParam : user.id;

  const [board, designers] = await Promise.all([
    targetId ? getDesignerBoard(user, targetId) : Promise.resolve(null),
    // Only needed for the mobile picker (the rail lives in the shell); cached,
    // so this shares the layout's query.
    isStaff ? getRailDesigners(user) : Promise.resolve([]),
  ]);

  const pickerDesigners = designers.map((d) => ({ id: d.id, name: d.name }));

  return (
    <Page className="max-w-none">
      <PageHeader
        title={isStaff ? "Designer board" : "My board"}
        description="Drag work from queue to design, then submit it for QC."
        actions={
          <>
            {isStaff && (
              // Mobile / narrow screens: the right rail is hidden, so keep a dropdown.
              <div className="lg:hidden">
                <DesignerPicker designers={pickerDesigners} current={targetId} />
              </div>
            )}
            {board && (
              <div className="w-36">
                <StatCard
                  label="Earned today"
                  value={`$${board.dailyEarnings.toFixed(2)}`}
                  tone="success"
                />
              </div>
            )}
          </>
        }
      />

      <div className="flex gap-4">
        {/* Left-hand designer switcher (staff only). */}
        {isStaff && <DesignerRail designers={designers} current={targetId} />}

        <div className="min-w-0 flex-1">
          {board ? (
            <DesignerBoard initial={board.columns} />
          ) : (
            <div className="rounded-card border border-line bg-surface shadow-sm">
              <EmptyState
                icon={Columns}
                headline="Select a designer"
                body="Pick a designer from the list on the left to view and manage their board."
              />
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
