import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, gte, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { businesses, exceptions, orders } from "@/lib/db/schema";
import { Badge, DataPanel, Disclosure, EmptyState, Page, PageHeader } from "@/components/ui";
import { AlertTriangle } from "@/components/ui/icons";
import { ResolveButton } from "@/components/exceptions/resolve-button";
import { formatAt } from "@/lib/time";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  photo_count_mismatch: "Photo count",
  intake_unparsed: "Intake needs a human",
  no_eligible_designer: "No designer free",
};

function kindLabel(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  const spaced = kind.replace(/[_.]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function ago(value: Date | string): string {
  const ms = Date.now() - new Date(value).getTime();
  const mins = Math.max(Math.floor(ms / 60000), 0);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function keyLabel(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function DetailList({ detail }: { detail: unknown }) {
  const obj = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
  const entries = Object.entries(obj);
  // The agent's suggestion leads, labelled plainly.
  entries.sort(([a], [b]) => (a === "suggested" ? -1 : b === "suggested" ? 1 : 0));
  if (entries.length === 0) return <p className="text-sm text-slate">No extra details.</p>;
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-medium text-ink">{k === "suggested" ? "Agent suggests" : keyLabel(k)}</dt>
          <dd className="min-w-0 break-words text-slate">{valueText(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

type Row = {
  id: string;
  kind: string;
  summary: string;
  detail: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  orderId: string | null;
  orderName: string | null;
  businessName: string;
};

function OrderLink({ row }: { row: Row }) {
  if (!row.orderId) return null;
  return (
    <Link href={`/orders/${row.orderId}`} className="font-medium text-pigment hover:underline">
      {row.orderName ?? "Order"}
    </Link>
  );
}

export default async function ExceptionsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  if (user.role === "designer") redirect("/board");

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const select = {
    id: exceptions.id,
    kind: exceptions.kind,
    summary: exceptions.summary,
    detail: exceptions.detail,
    createdAt: exceptions.createdAt,
    resolvedAt: exceptions.resolvedAt,
    resolutionNote: exceptions.resolutionNote,
    orderId: exceptions.orderId,
    orderName: orders.platformOrderName,
    businessName: businesses.name,
  };
  const [open, resolved] = await withUserContext(user, async (tx) =>
    Promise.all([
      tx
        .select(select)
        .from(exceptions)
        .innerJoin(businesses, eq(businesses.id, exceptions.businessId))
        .leftJoin(orders, eq(orders.id, exceptions.orderId))
        .where(eq(exceptions.status, "open"))
        .orderBy(desc(exceptions.createdAt)),
      tx
        .select(select)
        .from(exceptions)
        .innerJoin(businesses, eq(businesses.id, exceptions.businessId))
        .leftJoin(orders, eq(orders.id, exceptions.orderId))
        .where(and(eq(exceptions.status, "resolved"), gte(exceptions.resolvedAt, weekAgo)))
        .orderBy(sql`${exceptions.resolvedAt} desc`)
        .limit(50),
    ]),
  );

  return (
    <Page>
      <PageHeader
        title="Exceptions"
        description="What the agent could not settle by itself. It shows its suggestion; you make the call."
      />

      {open.length === 0 ? (
        <DataPanel>
          <EmptyState
            icon={AlertTriangle}
            headline="Nothing waiting on you."
            body="The agent is handling intake and assignment."
          />
        </DataPanel>
      ) : (
        <ul className="flex flex-col gap-3">
          {(open as Row[]).map((row) => (
            <li key={row.id}>
              <DataPanel className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="warning">{kindLabel(row.kind)}</Badge>
                  <span className="text-sm text-slate">{row.businessName}</span>
                  <OrderLink row={row} />
                  <span className="ml-auto text-xs text-slate" title={formatAt(row.createdAt, { dateStyle: "medium", timeStyle: "short" })}>
                    {ago(row.createdAt)}
                  </span>
                </div>
                <p className="text-sm text-ink">{row.summary}</p>
                <Disclosure summary="Details" className="shadow-none ring-1 ring-line/70">
                  <DetailList detail={row.detail} />
                </Disclosure>
                <div className="flex flex-wrap justify-end">
                  <ResolveButton id={row.id} />
                </div>
              </DataPanel>
            </li>
          ))}
        </ul>
      )}

      {resolved.length > 0 && (
        <Disclosure summary="Resolved (last 7 days)" hint={`${resolved.length}`}>
          <ul className="flex flex-col divide-y divide-line/70">
            {(resolved as Row[]).map((row) => (
              <li key={row.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="neutral">{kindLabel(row.kind)}</Badge>
                  <span className="text-sm text-slate">{row.businessName}</span>
                  <OrderLink row={row} />
                  {row.resolvedAt && <span className="ml-auto text-xs text-slate">{ago(row.resolvedAt)}</span>}
                </div>
                <p className="text-sm text-ink">{row.summary}</p>
                {row.resolutionNote && <p className="text-xs text-slate">Note: {row.resolutionNote}</p>}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Page>
  );
}
