import { notFound, redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { getQcContext, getQcQueueIds } from "@/lib/qc/data";
import { QcScreen } from "@/components/qc/qc-screen";
import { withUserContext } from "@/lib/db";
import { getAutoQcView, latestSlots, slotAssetIds } from "@/lib/qc/auto-qc";
import { getSameBuyerView } from "@/lib/orders/same-buyer-view";

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

  // The buyer's other orders load in their own connection beside the QC reads (one buyer, several orders).
  const [ctx, queueIds, sameBuyer] = await Promise.all([
    getQcContext(user, orderId),
    getQcQueueIds(user, selected.id),
    getSameBuyerView(user, orderId),
  ]);

  if (!ctx) notFound();
  const autoQc = await withUserContext(user, (tx) =>
    getAutoQcView(tx, ctx.orderId, slotAssetIds(latestSlots(ctx.versions, ctx.portraits, ctx.proofFiles))),
  );

  return <QcScreen ctx={ctx} queueIds={queueIds} autoQc={autoQc} sameBuyer={sameBuyer} />;
}
