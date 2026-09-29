import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { getDayQueue, type DayImage, type DayPrintCard, type DayQcCard, type DayRevisionCard } from "@/lib/agent/day";
import { Badge, DataPanel, EmptyState, Page, PageHeader } from "@/components/ui";
import { CheckCircle } from "@/components/ui/icons";
import { DayCardActions } from "@/components/day/card-actions";
import { formatAt } from "@/lib/time";

export const dynamic = "force-dynamic";

function waiting(value: string): string {
  const mins = Math.max(Math.floor((Date.now() - new Date(value).getTime()) / 60000), 0);
  if (mins < 1) return "waiting just now";
  if (mins < 60) return `waiting ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `waiting ${hours}h`;
  return `waiting ${Math.floor(hours / 24)}d`;
}

function Kicker({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate">{children}</h3>;
}

function Thumb({ image, className, alt }: { image: DayImage; className: string; alt: string }) {
  if (!image.url) {
    return <div className={`${className} flex items-center justify-center rounded-md bg-canvas text-xs text-slate`}>No preview</div>;
  }
  return (
    <a
      href={image.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${alt} full size`}
      className={`${className} block overflow-hidden rounded-md bg-canvas ring-1 ring-line/70`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.url} alt={alt} loading="lazy" className="size-full object-cover" />
    </a>
  );
}

function CardHead({ card, label }: { card: { orderId: string; orderNumber: string; businessName: string; waitingSince: string }; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Badge variant="info">{label}</Badge>
      <Link href={`/orders/${card.orderId}`} className="min-h-11 content-center font-medium text-pigment hover:underline sm:min-h-0">
        {card.orderNumber}
      </Link>
      <span className="text-sm text-slate">{card.businessName}</span>
      <span className="ml-auto text-xs text-slate" title={formatAt(card.waitingSince, { dateStyle: "medium", timeStyle: "short" })}>
        {waiting(card.waitingSince)}
      </span>
    </div>
  );
}

function QcBody({ card }: { card: DayQcCard | DayRevisionCard }) {
  const revision = "revisionRequest" in card ? card : null;
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="order-2 min-w-0 md:order-1">
        {revision ? (
          <>
            <Kicker>Buyer asked for</Kicker>
            <blockquote className="rounded-md bg-amber/10 p-3 text-sm text-ink break-words whitespace-pre-wrap">{revision.revisionRequest}</blockquote>
            {revision.previousProof && (
              <div className="mt-3">
                <Kicker>Previous proof</Kicker>
                <Thumb image={revision.previousProof} alt="Previous proof" className="aspect-square w-24" />
              </div>
            )}
          </>
        ) : null}
        <div className={revision ? "mt-3" : ""}>
          <Kicker>Buyer photos ({card.buyerPhotos.length})</Kicker>
          {card.buyerPhotos.length ? (
            <div className="grid grid-cols-2 gap-2">
              {card.buyerPhotos.map((p, i) => (
                <Thumb key={p.id} image={p} alt={`Buyer photo ${i + 1}`} className="aspect-square w-full" />
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate">No buyer photos on file.</p>
          )}
        </div>
      </div>
      <div className="order-1 min-w-0 md:order-2">
        <Kicker>{revision ? "Redo" : "Finished portrait"}</Kicker>
        {card.portrait ? (
          <Thumb image={card.portrait} alt="Finished portrait" className="aspect-[4/5] w-full" />
        ) : (
          <p className="text-sm text-slate">No portrait uploaded.</p>
        )}
      </div>
    </div>
  );
}

function QcCardView({ card, kind }: { card: DayQcCard | DayRevisionCard; kind: "portrait" | "revision" }) {
  return (
    <DataPanel className="flex h-full flex-col gap-3 p-4">
      <CardHead card={card} label={kind === "portrait" ? "Portrait QC" : "Revision QC"} />
      <p className="text-sm text-ink break-words">
        {card.productLine}
        {card.designerName && <span className="text-slate"> · Designer: {card.designerName}</span>}
      </p>
      {card.buyerNotes && <p className="rounded-md bg-canvas p-2 text-sm text-slate break-words">Buyer notes: {card.buyerNotes}</p>}
      <QcBody card={card} />
      <div className="mt-auto pt-1">
        <DayCardActions orderId={card.orderId} kind={kind} checklist={card.checklist} />
      </div>
    </DataPanel>
  );
}

function PrintCardView({ card }: { card: DayPrintCard }) {
  const blocked = card.blockers.filter((b) => b.code !== "not_approved");
  return (
    <DataPanel className="flex h-full flex-col gap-3 p-4">
      <CardHead card={card} label="Print and ship" />
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
        <dt className="font-medium text-ink">Product</dt>
        <dd className="break-words text-slate">{card.productLine}</dd>
        <dt className="font-medium text-ink">Provider</dt>
        <dd className="text-slate">{card.providerLabel ?? "Not set"}</dd>
        <dt className="font-medium text-ink">Cost</dt>
        <dd className="text-slate">{card.costText ?? "No cost on the mapping yet"}</dd>
        <dt className="font-medium text-ink">Ship to</dt>
        <dd className="break-words text-slate">
          {card.addressLines.length ? card.addressLines.map((l) => <span key={l} className="block">{l}</span>) : "No address on the order"}
        </dd>
      </dl>
      <div>
        <Kicker>Print file</Kicker>
        {card.fileUrl ? (
          <a href={card.fileUrl} target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-3 rounded-md bg-canvas p-2 hover:bg-pigment-soft" aria-label="Open print file full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={card.fileUrl} alt="Print file" loading="lazy" className="size-20 shrink-0 rounded object-cover" />
            <span className="min-w-0 break-words text-sm text-pigment">{card.fileName ?? "Open print file"}</span>
          </a>
        ) : (
          <p className="text-sm text-slate">No print file yet.</p>
        )}
      </div>
      {blocked.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-amber">
          {blocked.map((b) => (
            <li key={`${b.code}-${b.itemId ?? ""}`}>{b.message}</li>
          ))}
        </ul>
      )}
      <div className="mt-auto pt-1">
        <DayCardActions
          orderId={card.orderId}
          kind="print"
          checklist={[]}
          approveDisabledReason={card.ready ? null : "Fix the items above before this can be sent."}
        />
      </div>
    </DataPanel>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="font-display text-lg font-semibold text-ink">
        {title} <span className="text-slate">({count})</span>
      </h2>
      <ul className="grid gap-4 xl:grid-cols-2">{children}</ul>
    </section>
  );
}

export default async function DayPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const { selected } = await loadShellData(user);
  const q = await getDayQueue(user, selected.id);
  const waitingTotal = q.portrait.length + q.revision.length + q.print.length;

  return (
    <Page className="max-w-[1280px]">
      <PageHeader
        eyebrow={selected.name}
        title="Day"
        description={`Waiting: portrait QC ${q.portrait.length}, revision QC ${q.revision.length}, print and ship ${q.print.length}. Done today by you: ${q.doneToday}.`}
      />
      {waitingTotal === 0 ? (
        <DataPanel>
          <EmptyState
            icon={CheckCircle}
            headline="Nothing waiting."
            body={`Exceptions: ${q.openExceptions} open`}
            action={
              <Link href="/exceptions" className="inline-flex min-h-11 items-center font-medium text-pigment hover:underline">
                Open exceptions
              </Link>
            }
          />
        </DataPanel>
      ) : (
        <>
          <Group title="Portrait QC" count={q.portrait.length}>
            {q.portrait.map((c) => (
              <li key={c.orderId}>
                <QcCardView card={c} kind="portrait" />
              </li>
            ))}
          </Group>
          <Group title="Revision QC" count={q.revision.length}>
            {q.revision.map((c) => (
              <li key={c.orderId}>
                <QcCardView card={c} kind="revision" />
              </li>
            ))}
          </Group>
          <Group title="Print and ship" count={q.print.length}>
            {q.print.map((c) => (
              <li key={c.orderId}>
                <PrintCardView card={c} />
              </li>
            ))}
          </Group>
        </>
      )}
    </Page>
  );
}
