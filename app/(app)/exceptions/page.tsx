import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, gte, sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withSystemContext, withUserContext } from "@/lib/db";
import { listDesignerChoices, type DesignerChoice } from "@/lib/agent/legacy-intake";
import { listBusinessStyles } from "@/lib/designers/styles";
import { LegacyConfirmForm, PickDesignerForm } from "@/components/exceptions/intake-cards";
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
  reply_unclear: "Buyer reply unclear",
  buyer_question: "Buyer question",
  unmatched_reply: "Reply with no order",
  email_send_failed: "Email failed to send",
  legacy_order: "Order not in AlphaOS",
  new_product: "New product",
  ai_designer_failed: "AI portrait failed",
  addon_only: "Add-on only",
};

/** The one thing to do, as a short imperative; `to` is where the primary button goes. */
const TODO: Record<string, { line: string; button?: string; to?: "order" | "messages" }> = {
  photo_count_mismatch: { line: "Ask the buyer for one more photo.", button: "Open order", to: "order" },
  intake_unparsed: { line: "Fill in the order details.", button: "Open order", to: "order" },
  no_eligible_designer: { line: "Pick a designer for this order.", button: "Open order", to: "order" },
  // The buyer's thread lives on the order page (Email customer), so a reply on a known order opens the order.
  reply_unclear: { line: "Ask the buyer if they approve or want changes.", button: "Open order", to: "order" },
  buyer_question: { line: "Answer the buyer's question.", button: "Open order", to: "order" },
  unmatched_reply: { line: "Find the order this email belongs to.", button: "Open messages", to: "messages" },
  email_send_failed: { line: "Fix the address, then retry the email.", button: "Open messages", to: "messages" },
  legacy_order: { line: "Check Trello, then confirm the order below." },
  new_product: { line: "Pick who draws this new product." },
  ai_designer_failed: { line: "Check the AI portrait, or give it to a designer.", button: "Open order", to: "order" },
  addon_only: { line: "Match it to the buyer's portrait order, then print or close it.", button: "Open order", to: "order" },
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

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Any detail value as plain words, never raw JSON: a date reads as a date, a
 * list as a comma list, an object as "Key: value" pairs. Nested shapes the
 * agent writes (a designer roster, Etsy variations) read as one line each.
 */
function valueText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (typeof v === "string") return ISO_RE.test(v) ? formatAt(v, { dateStyle: "medium", timeStyle: "short" }) : v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.length ? v.map(valueText).join("; ") : "none";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Roster line: "Mia Designer: does not do renaissance"
    if (typeof o.name === "string" && Array.isArray(o.blockers)) {
      return `${o.name}: ${o.blockers.length ? o.blockers.map(valueText).join(", ") : "free"}`;
    }
    // Etsy variation: "Vibe Zzz Unknown Flavour"
    if (typeof o.formatted_name === "string") return `${o.formatted_name} ${valueText(o.formatted_value)}`;
    if (typeof o.title === "string" && Array.isArray(o.variations)) {
      return o.variations.length ? `${o.title} (${o.variations.map(valueText).join(", ")})` : o.title;
    }
    const parts = Object.entries(o)
      .filter(([k, x]) => !isInternalKey(k) && x !== null && x !== undefined && x !== "")
      .map(([k, x]) => `${keyLabel(k)}: ${valueText(x)}`);
    return parts.length ? parts.join("; ") : "none";
  }
  return String(v);
}

/** Ids and machine keys a person never needs to read. */
function isInternalKey(key: string): boolean {
  return /(^id$|Id$|_id$)/.test(key);
}

function detailString(detail: unknown, key: string): string {
  const v = detail && typeof detail === "object" ? (detail as Record<string, unknown>)[key] : null;
  return typeof v === "string" && key !== "from" ? v : typeof v === "string" && v.includes("@") ? v : "";
}

function keyLabel(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The agent's suggestion as one plain sentence. `suggested` is either a
 * sentence already (inbox: reply_unclear, buyer_question) or the parsed intake
 * guess {figureCount, style, productType} (intake_unparsed). An object may
 * also carry its own summary/text.
 */
function suggestionText(suggested: unknown): string | null {
  if (suggested === null || suggested === undefined) return null;
  if (typeof suggested === "string") return suggested.trim() || null;
  if (typeof suggested !== "object" || Array.isArray(suggested)) return valueText(suggested);
  const s = suggested as Record<string, unknown>;
  for (const key of ["summary", "text"]) {
    if (typeof s[key] === "string" && (s[key] as string).trim()) return (s[key] as string).trim();
  }
  const parts: string[] = [];
  if (typeof s.figureCount === "number") parts.push(`${s.figureCount} ${s.figureCount === 1 ? "figure" : "figures"}`);
  if (typeof s.style === "string" && s.style) parts.push(`${keyLabel(s.style)} style`);
  if (typeof s.productType === "string" && s.productType) parts.push(`${s.productType} product`);
  if (parts.length) return `Best guess from the order: ${parts.join(", ")}. Check it, then fill in the order details.`;
  return null;
}

function SuggestionBlock({ detail }: { detail: unknown }) {
  const obj = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
  const text = suggestionText(obj.suggested);
  if (!text) return null;
  return (
    <div className="rounded-card bg-pigment-soft px-3 py-2.5">
      <p className="text-xs font-medium text-pigment">Agent suggests</p>
      <p className="mt-0.5 break-words text-sm text-ink">{text}</p>
    </div>
  );
}

function DetailList({ detail }: { detail: unknown }) {
  const obj = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
  // The suggestion has its own block above the card details.
  const entries = Object.entries(obj).filter(([k]) => k !== "suggested" && !isInternalKey(k));
  if (entries.length === 0) return <p className="text-sm text-slate">No extra details.</p>;
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-medium text-ink">{keyLabel(k)}</dt>
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
  businessId: string;
  orderId: string | null;
  orderName: string | null;
  businessName: string;
};

function OrderLink({ row }: { row: Row }) {
  if (!row.orderId) return null;
  return (
    <Link href={`/orders/${row.orderId}`} className="-my-2.5 inline-flex min-h-11 items-center font-medium text-pigment hover:underline">
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
    businessId: exceptions.businessId,
    orderId: exceptions.orderId,
    orderName: sql<string | null>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
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

  // Data for the two intake cards' forms (staff-only page).
  const rows = open as Row[];
  const legacyBiz = [...new Set(rows.filter((r) => r.kind === "legacy_order").map((r) => r.businessId))];
  const productBiz = [...new Set(rows.filter((r) => r.kind === "new_product").map((r) => r.businessId))];
  const styleNames = new Map<string, string[]>();
  const designerOptions = new Map<string, DesignerChoice[]>();
  if (legacyBiz.length || productBiz.length) {
    await withSystemContext(async (tx) => {
      for (const id of legacyBiz) {
        const list = await listBusinessStyles(tx, id);
        styleNames.set(id, list.map((x) => x.name));
      }
      for (const id of productBiz) designerOptions.set(id, await listDesignerChoices(tx, id));
    });
  }

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
          {rows.map((row) => (
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
                <p className="text-base font-semibold text-ink">{TODO[row.kind]?.line ?? row.summary}</p>
                {TODO[row.kind] && <p className="-mt-2 text-sm text-slate">{row.summary}</p>}
                <SuggestionBlock detail={row.detail} />
                <Disclosure summary="Details" className="shadow-none ring-1 ring-line/70">
                  <DetailList detail={row.detail} />
                </Disclosure>
                {row.kind === "legacy_order" && (
                  <LegacyConfirmForm
                    exceptionId={row.id}
                    styleOptions={styleNames.get(row.businessId) ?? []}
                    defaults={{
                      customerName: detailString(row.detail, "buyerName"),
                      customerEmail: detailString(row.detail, "from"),
                    }}
                  />
                )}
                {row.kind === "new_product" && (
                  <PickDesignerForm
                    exceptionId={row.id}
                    designers={(designerOptions.get(row.businessId) ?? []).map((d) => ({ id: d.id, name: d.name, openCount: d.openCount }))}
                  />
                )}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {(() => {
                    const todo = TODO[row.kind];
                    if (!todo?.button) return null;
                    // No order on the card: the message is the only place to act on it.
                    const toOrder = todo.to === "order" && row.orderId;
                    if (todo.to === "order" && !row.orderId && row.kind !== "reply_unclear" && row.kind !== "buyer_question") return null;
                    return (
                      <Link
                        href={toOrder ? `/orders/${row.orderId}` : "/emails"}
                        className="inline-flex min-h-11 items-center rounded-input bg-pigment px-4 text-sm font-medium text-surface hover:opacity-90"
                      >
                        {toOrder ? todo.button : "Open messages"}
                      </Link>
                    );
                  })()}
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
