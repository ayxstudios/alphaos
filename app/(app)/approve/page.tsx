import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getApproveItem, getApproveQueue } from "@/lib/qc/approve-data";
import { ApproveScreen } from "@/components/qc/approve-screen";
import { EmptyState, Page } from "@/components/ui";
import { CheckCircle } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

/**
 * Owner QC (2026-10-14): one order at a time, NEW ORDER or REVISION, Approve
 * or Reject. Every business in one queue, urgent first then soonest due.
 * ?o=<orderId> shows that order when it is still waiting.
 */
export default async function ApprovePage({ searchParams }: { searchParams: Promise<{ o?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/approve");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer" || user.role === "helper") redirect("/board");

  const { o } = await searchParams;
  const queue = await getApproveQueue(user);
  if (queue.length === 0) {
    return (
      <Page className="max-w-xl">
        <EmptyState
          icon={CheckCircle}
          headline="All done"
          body="Nothing to check right now. New artwork shows up here as soon as a designer hands it in."
        />
      </Page>
    );
  }

  const index = o && queue.includes(o) ? queue.indexOf(o) : 0;
  const item = await getApproveItem(user, queue[index]);
  if (!item) redirect("/approve");
  const nextId = queue.length > 1 ? queue[(index + 1) % queue.length] : null;

  return <ApproveScreen key={item.ctx.orderId} item={item} position={index + 1} total={queue.length} nextId={nextId} />;
}
