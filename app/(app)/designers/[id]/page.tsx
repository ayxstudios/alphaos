import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getDesignerWeek } from "@/lib/designers/my-week";
import { DesignerWeekView } from "@/components/designers/week-view";
import { Page, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DesignerWeekPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  // Staff-only surface — a designer looks at their own week at /me instead.
  if (user.role === "designer") redirect("/board");

  const { id } = await params;
  const week = await getDesignerWeek(user, id);

  return (
    <Page className="max-w-xl">
      <PageHeader
        title={week.designerName}
        description="Same week view the designer sees on their phone."
      />
      <DesignerWeekView week={week} />
    </Page>
  );
}
