import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getMyWeek } from "@/lib/designers/my-week";
import { DesignerWeekView } from "@/components/designers/week-view";
import { Page, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function MyWeekPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  // Staff have no "self" designer week — they look at a specific designer
  // from the Designers page instead.
  if (user.role !== "designer") redirect("/designers");

  const week = await getMyWeek(user);

  return (
    <Page className="max-w-xl">
      <PageHeader title="My week" description={`Hi ${week.designerName.split(" ")[0]}, here's how this week is going.`} />
      <DesignerWeekView week={week} />
    </Page>
  );
}
