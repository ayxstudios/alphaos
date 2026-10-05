import { notFound, redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { getQcContext, getQcQueueIds, getQcSignoffNames } from "@/lib/qc/data";
import { QcScreen } from "@/components/qc/qc-screen";

export const dynamic = "force-dynamic";

export default async function QcPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  // QC is VA/admin only — designers never see the gate.
  if (user.role === "designer" || user.role === "helper") redirect("/board");

  const { orderId } = await params;
  const { selected } = await loadShellData(user);

  const [ctx, queueIds, teamNames] = await Promise.all([
    getQcContext(user, orderId),
    getQcQueueIds(user, selected.id),
    getQcSignoffNames(user),
  ]);

  if (!ctx) notFound();

  return <QcScreen ctx={ctx} queueIds={queueIds} teamNames={teamNames} />;
}
