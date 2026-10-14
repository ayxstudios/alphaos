import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getApproveItem, getOwnerApproveQueue } from "@/lib/qc/approve-data";
import { PendingApprovalsHost } from "@/components/qc/pending-approvals";
import { parseSkip } from "@/components/qc/pending-approvals-store";
import { ApproveScreen } from "@/components/qc/approve-screen";
import { EmptyState, Page } from "@/components/ui";
import { CheckCircle } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

/**
 * Owner QC (2026-10-14): one order at a time, NEW ORDER or REVISION, Approve
 * or Reject. Every business in one queue, urgent first then soonest due.
 * ?o=<orderId> shows that order when it is still waiting. An order another
 * owner has open is not offered (lib/qc/claims.ts): the two never overlap.
 */
export default async function ApprovePage({ searchParams }: { searchParams: Promise<{ o?: string; skip?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/approve");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer" || user.role === "helper") redirect("/board");

  const { o, skip } = await searchParams;
  // Approvals still in their Stop window stay out of the queue (an explicitly opened ?o= never hides itself).
  const { ids: queue, start, others, takenBy } = await getOwnerApproveQueue(user, parseSkip(skip).filter((id) => id !== o), o);
  if (queue.length === 0) {
    const busy = others.map((x) => `${x.name} is checking ${x.count === 1 ? "the last one" : `the last ${x.count}`}.`).join(" ");
    return (
      <Page className="max-w-xl">
        <PendingApprovalsHost all />
        <EmptyState
          icon={CheckCircle}
          headline="All done"
          body={
            busy
              ? `Nothing else to check. ${busy}`
              : "Nothing to check right now. New artwork shows up here as soon as a designer hands it in."
          }
        />
      </Page>
    );
  }

  const index = start;
  const item = await getApproveItem(user, queue[index]);
  if (!item) redirect("/approve");
  const nextId = queue.length > 1 ? queue[(index + 1) % queue.length] : null;

  return (
    <ApproveScreen
      key={item.ctx.orderId}
      item={item}
      position={index + 1}
      total={queue.length}
      nextId={nextId}
      others={others}
      takenBy={takenBy}
    />
  );
}
