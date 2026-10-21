import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getApproveItem, getOwnerApproveQueue } from "@/lib/qc/approve-data";
import { parseStream, type Stream } from "@/lib/qc/approve-streams";
import { listCases } from "@/lib/cases/cards";
import { getSameBuyerView } from "@/lib/orders/same-buyer-view";
import { PendingApprovalsHost } from "@/components/qc/pending-approvals";
import { parseSkip } from "@/components/qc/pending-approvals-store";
import { ApproveScreen } from "@/components/qc/approve-screen";
import { StreamTabs } from "@/components/qc/approve-streams";
import { CaseScreen } from "@/components/qc/case-screen";
import { EmptyState, Page } from "@/components/ui";
import { CheckCircle } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

/**
 * Owner QC (2026-10-14): one order at a time, Approve or Reject. Three streams (2026-10-21): New orders, Revisions and
 * Cases (a customer who needs a person: lib/cases/cards.ts). ?s= picks the stream; ?o=<orderId> opens that order and its
 * stream. Every business in one queue, urgent first then soonest due. An order another owner has open is not offered
 * (lib/qc/claims.ts): the two never overlap.
 */
export default async function ApprovePage({ searchParams }: { searchParams: Promise<{ o?: string; skip?: string; s?: string; c?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/approve");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer" || user.role === "helper") redirect("/board");

  const { o, skip, s, c } = await searchParams;
  const isOwner = user.role === "admin";
  const asked = parseStream(s);
  const wantCases = asked === "cases" && isOwner;

  // Approvals still in their Stop window stay out of the queue (an explicitly opened ?o= never hides itself).
  const [q, cases] = await Promise.all([
    getOwnerApproveQueue(user, parseSkip(skip).filter((id) => id !== o), o, asked === "revision" ? "revision" : asked === "new" ? "new" : undefined),
    isOwner ? listCases() : Promise.resolve(undefined),
  ]);
  const { ids: queue, start, others, takenBy, counts } = q;

  // No stream asked for and nothing in the order streams: the cases are what is left.
  const active: Stream = wantCases || (!asked && !o && counts.new + counts.revision === 0 && (cases?.length ?? 0) > 0) ? "cases" : q.stream;
  const tabs = (
    <StreamTabs
      active={active}
      counts={{ new: counts.new, revision: counts.revision, cases: cases === undefined ? undefined : (cases?.length ?? null) }}
      casesUrgent={!!cases?.some((x) => x.urgent)}
    />
  );

  if (active === "cases") {
    if (cases === null || cases === undefined) {
      return (
        <div className="flex flex-col gap-4">
          {tabs}
          <Page className="max-w-xl">
            <EmptyState icon={CheckCircle} headline="Cases did not load" body="I couldn't reach the case list just now. Reload in a minute; nothing is lost." />
          </Page>
        </div>
      );
    }
    if (cases.length === 0) {
      return (
        <div className="flex flex-col gap-4">
          {tabs}
          <Page className="max-w-xl">
            <EmptyState icon={CheckCircle} headline="No cases" body="Nothing needs you. I settle customer problems myself and bring you only the ones I can't." />
          </Page>
        </div>
      );
    }
    const at = Math.max(0, cases.findIndex((x) => x.id === c));
    const card = cases[at];
    const nextId = cases.length > 1 ? cases[(at + 1) % cases.length].id : null;
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <CaseScreen key={card.id} card={card} position={at + 1} total={cases.length} nextId={nextId} />
      </div>
    );
  }

  if (queue.length === 0) {
    const busy = others.map((x) => `${x.name} is checking ${x.count === 1 ? "the last one" : `the last ${x.count}`}.`).join(" ");
    const label = q.stream === "revision" ? "revisions" : "new orders";
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <Page className="max-w-xl">
          <PendingApprovalsHost all />
          <EmptyState
            icon={CheckCircle}
            headline="All done"
            body={
              busy
                ? `Nothing else to check. ${busy}`
                : `No ${label} to check right now. They show up here as soon as a designer hands them in.`
            }
          />
        </Page>
      </div>
    );
  }

  const index = start;
  // The buyer's other orders load in their own connection beside the order (one buyer, several orders).
  const [item, sameBuyer] = await Promise.all([getApproveItem(user, queue[index]), getSameBuyerView(user, queue[index])]);
  if (!item) redirect(`/approve?s=${q.stream}`);
  const nextId = queue.length > 1 ? queue[(index + 1) % queue.length] : null;

  return (
    <div className="flex flex-col gap-4">
      {tabs}
      <ApproveScreen
        key={item.ctx.orderId}
        item={item}
        position={index + 1}
        total={queue.length}
        nextId={nextId}
        others={others}
        takenBy={takenBy}
        sameBuyer={sameBuyer}
      />
    </div>
  );
}
