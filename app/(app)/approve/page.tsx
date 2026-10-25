import { Suspense } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getApproveItem, getArtworkPreloadUrls, getDuplicateSlotsStop, getOwnerApproveQueue, getPictureMatchStop } from "@/lib/qc/approve-data";
import { parseStream, type Stream } from "@/lib/qc/approve-streams";
import { listCases, listCasesForCount, type CaseCard } from "@/lib/cases/cards";
import { getSameBuyerView } from "@/lib/orders/same-buyer-view";
import { PendingApprovalsHost } from "@/components/qc/pending-approvals";
import { parseSkip } from "@/components/qc/pending-approvals-store";
import { ApproveScreen } from "@/components/qc/approve-screen";
import { StreamTabs } from "@/components/qc/approve-streams";
import { CaseDeck } from "@/components/qc/case-screen";
import { EmptyState, Page, Skeleton } from "@/components/ui";
import { CheckCircle } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

type Counts = { new: number; revision: number };

/** The tabs once the case list is in (it streams in after the order; see below). */
async function TabsWithCases({ active, counts, cases }: { active: Stream; counts: Counts; cases: Promise<CaseCard[] | null> }) {
  const list = await cases;
  return <StreamTabs active={active} counts={{ ...counts, cases: list?.length ?? null }} casesUrgent={!!list?.some((x) => x.urgent)} />;
}

/** The Cases stream once its list is in. Opened from the tabs it streams in after a placeholder, so the tab moves at once. */
async function CasesBody({ cases, at, startId, counts }: { cases: Promise<CaseCard[] | null> | CaseCard[] | null; at: number; startId: string | null; counts: Counts }) {
  const list = await cases;
  if (!list) {
    return (
      <div className="flex flex-col gap-4">
        <StreamTabs active="cases" counts={{ ...counts, cases: null }} />
        <Page className="max-w-xl">
          <EmptyState icon={CheckCircle} headline="Cases did not load" body="I couldn't reach the case list just now. Reload in a minute; nothing is lost." />
        </Page>
      </div>
    );
  }
  // The whole pile goes to the screen: a swipe shows the next case at once (components/qc/case-screen.tsx).
  return <CaseDeck cards={list} at={at} startId={startId} counts={counts} />;
}

function CasesLoading({ counts }: { counts: Counts }) {
  return (
    <div className="flex flex-col gap-4">
      <StreamTabs active="cases" counts={{ ...counts, cases: null }} casesPending />
      <Page className="max-w-xl">
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-64 rounded-card" />
          <Skeleton className="h-12 rounded-card" />
        </div>
      </Page>
    </div>
  );
}

/**
 * Owner QC (2026-10-14): one order at a time, Approve or Reject. Three streams (2026-10-21): New orders, Revisions and
 * Cases (a customer who needs a person: lib/cases/cards.ts). ?s= picks the stream; ?o=<orderId> opens that order and its
 * stream. Every business in one queue, urgent first then soonest due. An order another owner has open is not offered
 * (lib/qc/claims.ts): the two never overlap.
 *
 * The case list comes from the agent's page in the US (~2.5 s). From 21 Oct every order waited for it; since 22 Oct
 * the order shows at once and only the Cases count streams in after (a copy up to 30 s old, listCasesForCount).
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
  // Started now, awaited only where the page needs the list itself (the Cases stream, or nothing else left).
  // A plain /approve may land on the Cases stream (nothing else left), so it reads fresh too.
  const casesAt = Date.now();
  const casesP: Promise<CaseCard[] | null> | undefined = isOwner ? (wantCases || (!asked && !o) ? listCases() : listCasesForCount()) : undefined;
  const q = await getOwnerApproveQueue(
    user,
    parseSkip(skip).filter((id) => id !== o),
    o,
    asked === "revision" ? "revision" : asked === "new" ? "new" : undefined,
  );
  const { ids: queue, start, others, takenBy, counts } = q;

  // No stream asked for and nothing in the order streams: the cases are what is left.
  const ordersLeft = counts.new + counts.revision > 0;
  // The Cases tab itself does not wait here: its list streams in behind a placeholder (CasesBody).
  const casesNow = casesP && !asked && !o && !ordersLeft ? await casesP : undefined;
  const active: Stream = wantCases || (!asked && !o && !ordersLeft && (casesNow?.length ?? 0) > 0) ? "cases" : q.stream;
  const tabs = !casesP ? (
    <StreamTabs active={active} counts={{ new: counts.new, revision: counts.revision }} />
  ) : casesNow !== undefined ? (
    <StreamTabs
      active={active}
      counts={{ new: counts.new, revision: counts.revision, cases: casesNow?.length ?? null }}
      casesUrgent={!!casesNow?.some((x) => x.urgent)}
    />
  ) : (
    <Suspense fallback={<StreamTabs active={active} counts={{ new: counts.new, revision: counts.revision, cases: null }} casesPending />}>
      <TabsWithCases active={active} counts={{ new: counts.new, revision: counts.revision }} cases={casesP} />
    </Suspense>
  );

  if (active === "cases") {
    const two = { new: counts.new, revision: counts.revision };
    if (casesNow !== undefined) return <CasesBody cases={casesNow} at={casesAt} startId={c ?? null} counts={two} />;
    return (
      <Suspense fallback={<CasesLoading counts={two} />}>
        <CasesBody cases={casesP ?? null} at={casesAt} startId={c ?? null} counts={two} />
      </Suspense>
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
  const nextId = queue.length > 1 ? queue[(index + 1) % queue.length] : null;
  // The buyer's other orders load in their own connection beside the order (one buyer, several orders), and the next
  // order's artwork URLs, so its picture downloads meanwhile. The picture checks (up to 2.5 s each, shown before the
  // tap) stream in after the order is on screen (2026-10-25: they held every order page ~3 s).
  const matchStops = Promise.all([getPictureMatchStop(queue[index]), getDuplicateSlotsStop(user, queue[index])])
    .then((found) => found.filter((x) => x !== null))
    .catch(() => []);
  const [item, sameBuyer, nextArt] = await Promise.all([
    getApproveItem(user, queue[index]),
    getSameBuyerView(user, queue[index]),
    getArtworkPreloadUrls(user, nextId),
  ]);
  if (!item) redirect(`/approve?s=${q.stream}`);

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
        nextArt={nextArt}
        matchStops={matchStops}
      />
    </div>
  );
}
