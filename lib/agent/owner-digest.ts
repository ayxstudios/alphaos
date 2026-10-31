// Owner digest (docs/NO_LIMBO.md L5). Whatever is stuck and needs the owner
// reaches them as ONE short Alpha message an hour at most: what is stuck and
// what I would do, one dot line per order, each with its link. Nothing else
// talks to the owner about limbo.
import { and, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import { sendAlphaEvent } from "@/lib/alpha/client";
import { withSystemContext, type Tx } from "@/lib/db";
import { alphaEvents, businesses, exceptions, orders, shops } from "@/lib/db/schema";
import { appUrl } from "@/lib/urls";
import { getAgentConfig } from "./config";
import { CLOSED_STATUSES, EMAIL_GRACE_HOURS } from "./limbo";
import {
  agentFallback,
  agentStateOf,
  OWNER_TAG_WORDS,
  roadOf,
  type OwnerTag,
} from "./needs-you";
import { legacyQuiet } from "./scope";

const HOUR = 3_600_000;

/**
 * Hours an open row waits before the owner hears about it, so the automatic
 * fixes get the first go. null = never raised (photo_count_mismatch: the buyer
 * is inside the shortfall window and the assigner goes ahead after it).
 */
export const GRACE_HOURS: Record<string, number | null> = {
  no_eligible_designer: 0,
  addon_only: 0,
  stuck_order: 0,
  designer_backlog: 0,
  reply_unclear: 1,
  buyer_question: 1,
  unmatched_reply: 1,
  ai_designer_failed: 1,
  email_send_failed: 2,
  intake_unparsed: 2,
  legacy_order: 2,
  new_product: 2,
  photo_count_mismatch: null,
  // The pet slots: the team's card on /exceptions, never an owner line (owner notifications 2026-10-27).
  photo_subject_missing: null,
};
const OTHER_KIND_GRACE_HOURS = 2;
export const DIGEST_EVERY_MINUTES = 60;
export const RERAISE_AFTER_HOURS = 24;
export const MAX_RAISES = 3;
export const MAX_LINES = 8;
export const DIGEST_SOURCE = "no_limbo";

/** Lines lead with what a buyer is waiting on. */
const KIND_ORDER = [
  "reply_unclear",
  "buyer_question",
  "unmatched_reply",
  "stuck_order",
  "no_eligible_designer",
  "ai_designer_failed",
  "addon_only",
  "email_send_failed",
  "intake_unparsed",
  "legacy_order",
  "new_product",
  "designer_backlog",
];

/** What I would do, when the row that found the problem did not say. */
const DEFAULT_RECOMMENDATION: Record<string, string> = {
  reply_unclear: "Read the buyer's email on the order page and reply.",
  buyer_question: "Read the buyer's email on the order page and reply.",
  unmatched_reply: "Open it and link it to an order, or mark the sender as not a customer.",
  email_send_failed: "Check the buyer's email address on the order and resend.",
  intake_unparsed: "Open the order and fill in what is missing.",
  // The card text already says what to do (check Trello, confirm here).
  legacy_order: "",
  new_product: "Map the product to a style.",
  ai_designer_failed: "Give it to a designer.",
  no_eligible_designer: "Give it to a designer who draws this style.",
  addon_only: "Link it to the buyer's portrait order.",
  stuck_order: "Open the order and decide who takes it.",
  designer_backlog: "Raise the designer's daily limit or add a second designer.",
};

export type DigestCandidate = {
  kind: string;
  createdAt: Date;
  escalatedAt: string | null;
  escalations: number;
  /** Only the buyer's email is missing: the email filler's window applies, not the kind's. */
  emailOnly?: boolean;
};

/**
 * An intake row whose only gap is an unread buyer email. The buyer-email
 * filler reads it off the Etsy order page by itself, so the owner never hears
 * about it inside EMAIL_GRACE_HOURS. A malformed email is a different gap.
 */
export function onlyEmailMissing(kind: string, detail: Record<string, unknown>): boolean {
  if (kind !== "intake_unparsed" || !Array.isArray(detail.missing)) return false;
  const missing = detail.missing.filter((m): m is string => typeof m === "string");
  return missing.length > 0 && missing.every((m) => /^customer email \((Etsy did not share|not read from)/i.test(m));
}

/** A revision nobody holds: only an owner moves a revision (REVISIONS STAY, 2026-10-16). */
export const REVISION_WORDS = "A revision moves only with your yes: say who takes it, the designer who drew it if they can.";

/** The line for an unread email, once the filler's window has passed. */
export const EMAIL_ONLY_WORDS = {
  summary: `I could not read the buyer's email from the Etsy order in ${EMAIL_GRACE_HOURS} hours, so the photo link has not gone out`,
  recommendation: "Message the buyer on Etsy for the photos. I keep trying for the email.",
};

/** Hours the row waits before anyone hears about it; null = never raised. */
export function graceHours(c: Pick<DigestCandidate, "kind" | "emailOnly">): number | null {
  return c.emailOnly ? EMAIL_GRACE_HOURS : c.kind in GRACE_HOURS ? GRACE_HOURS[c.kind] : OTHER_KIND_GRACE_HOURS;
}

/** Past its grace, not raised in the last day, raised fewer than MAX_RAISES times. */
export function isDue(c: DigestCandidate, now: Date): boolean {
  const grace = graceHours(c);
  if (grace === null) return false;
  if (now.getTime() - c.createdAt.getTime() < grace * HOUR) return false;
  if (c.escalations >= MAX_RAISES) return false;
  if (c.escalatedAt) {
    const at = Date.parse(c.escalatedAt);
    if (!Number.isNaN(at) && now.getTime() - at < RERAISE_AFTER_HOURS * HOUR) return false;
  }
  return true;
}

/** The owner's words, not the system's: no dashes, no "exception" or "agent". */
export function plainWords(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\bexceptions\b/gi, "issues")
    .replace(/\bexception\b/gi, "issue")
    .replace(/\bAI agent\b/gi, "AI")
    .replace(/\bthe agent\b/gi, "I")
    .replace(/\bagent\b/gi, "AI")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(s: string, max = 160): string {
  let t = s.trim().replace(/[\s.!;:,]+$/, "");
  if (t.length > max) t = `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}...`;
  return t ? `${t}.` : "";
}

/** "Order #4201839306: can't tell ..." (or "Etsy order #..."): the line already names the order. */
export function stripOrderPrefix(summary: string): string {
  return summary.replace(/^\s*(?:(?:etsy|shopify)\s+)?order\s+#?[\w-]+\s*:\s*/i, "");
}

export type DigestLine = {
  exceptionId: string;
  /** Every row this line stands for (one per email when a sender wrote twice). */
  exceptionIds: string[];
  /** Same order (or, with no order, same sender) and same kind = one line. */
  groupKey: string;
  businessId: string;
  kind: string;
  /** Short shop label: "CPS", "PixArt". */
  shop: string;
  number: string | null;
  summary: string;
  recommendation: string;
  /** The buyer's own words, for mail the owner has to decide on. */
  said?: string | null;
  link: string;
  createdAt: Date;
  /** Why it is the owner's (./needs-you.ts): upset buyer, money back, legal, a revision. */
  tags?: OwnerTag[];
};

const MAIL_KINDS = ["reply_unclear", "buyer_question", "unmatched_reply", "legacy_order"];

/** An email excerpt as one short quote: entities decoded, links and quoted history dropped. */
export function buyerWords(excerpt: unknown, max = 140): string | null {
  if (typeof excerpt !== "string") return null;
  let t = excerpt
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<https?:[^>]*>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\bOn [^\n]{0,80}wrote:[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  if (t.length > max) t = `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}...`;
  return t.replace(/"/g, "'");
}

export function lineFor(l: DigestLine): string {
  // What makes it the owner's leads, in bold: "*Upset buyer, money back.* CPS 1234: ..."
  const tags = (l.tags ?? []).map((t, i) => (i ? OWNER_TAG_WORDS[t].toLowerCase() : OWNER_TAG_WORDS[t]));
  const lead = tags.length ? `*${tags.join(", ")}.* ` : "";
  const label = (lead + [l.shop, l.number].filter(Boolean).join(" ")).trim();
  const n = l.exceptionIds.length;
  const times = n > 1 ? ` (${n} ${MAIL_KINDS.includes(l.kind) ? "emails" : "times"})` : "";
  const summary = sentence(plainWords(stripOrderPrefix(l.summary)).replace(/[\s.]+$/, "") + times);
  const said = l.said ? `They wrote: "${l.said}"` : "";
  const fallback = l.kind in DEFAULT_RECOMMENDATION ? DEFAULT_RECOMMENDATION[l.kind] : "Open it and decide.";
  const rec = sentence(plainWords(l.recommendation || fallback));
  return `• ${label}: ${[summary, said, rec, l.link].filter(Boolean).join(" ")}`;
}

/** One line per order (or sender) and kind; the oldest row speaks for the group. */
export function mergeLines(lines: DigestLine[]): DigestLine[] {
  const byKey = new Map<string, DigestLine>();
  for (const l of [...lines].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = `${l.businessId}|${l.kind}|${l.groupKey}`;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { ...l, exceptionIds: [...l.exceptionIds] });
    else {
      seen.exceptionIds.push(...l.exceptionIds);
      if (l.tags?.length) seen.tags = [...new Set([...(seen.tags ?? []), ...l.tags])];
      // The newest email is the one worth quoting.
      if (l.said) seen.said = l.said;
    }
  }
  return [...byKey.values()];
}

export function sortLines(lines: DigestLine[]): DigestLine[] {
  // An upset buyer, money back or a legal threat leads.
  const rank = (l: DigestLine) => {
    if (l.tags?.some((t) => t !== "revision")) return -1;
    const i = KIND_ORDER.indexOf(l.kind);
    return i < 0 ? KIND_ORDER.length : i;
  };
  return [...lines].sort((a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime());
}

export function digestText(lines: DigestLine[]): string {
  const shown = lines.slice(0, MAX_LINES).map(lineFor);
  const more = lines.length - shown.length;
  return [
    `AlphaOS needs you (${lines.length})`,
    ...shown,
    ...(more > 0 ? [`+${more} more: ${appUrl("/exceptions")}`] : []),
  ].join("\n");
}

/** "CPS Etsy" -> "CPS": the platform word adds nothing the owner needs. */
export function shortShopLabel(name: string): string {
  return name.replace(/\s+(etsy|shopify)$/i, "").trim() || name;
}

export type OwnerDigestResult = {
  /** People (or the admin role) the digest was worked out for. */
  recipients: number;
  /** Open rows past their grace. */
  due: number;
  /** Rows stamped as raised (dry run: would be). */
  raised: number;
  /** Alpha messages queued (dry run: would be). */
  sent: number;
  /** Recipients skipped because their last digest is under an hour old. */
  skippedRecent: number;
  /** The message texts (always filled; the dry run's preview). */
  texts: string[];
  /** Dry run only: every due line, including the ones past MAX_LINES. */
  allLines?: string[];
};

type Recipient = { userId: string | null; businessIds: string[] };

/**
 * One pass over every business: group by who hears about it
 * (agent_config.ownerUserId, else every admin), and per recipient send one
 * message with every due row, stamping detail.escalatedAt and
 * detail.escalations in the same transaction.
 */
export async function sendOwnerDigest(
  opts: {
    now?: Date;
    dryRun?: boolean;
    businessIds?: string[];
    /** Dry runs: rows the same tick would close before the digest runs. */
    skipIds?: string[];
  } = {},
): Promise<OwnerDigestResult> {
  const now = opts.now ?? new Date();
  const result: OwnerDigestResult = { recipients: 0, due: 0, raised: 0, sent: 0, skippedRecent: 0, texts: [] };
  if (opts.businessIds && opts.businessIds.length === 0) return result;

  const bizRows = await withSystemContext((tx) =>
    tx
      .select({ id: businesses.id, name: businesses.name, agentConfig: businesses.agentConfig })
      .from(businesses)
      .where(opts.businessIds ? inArray(businesses.id, opts.businessIds) : undefined)
      .orderBy(businesses.id),
  );
  const groups = new Map<string, Recipient>();
  for (const b of bizRows) {
    const userId = getAgentConfig(b).ownerUserId;
    const key = userId ?? "role:admin";
    const g = groups.get(key) ?? { userId, businessIds: [] };
    g.businessIds.push(b.id);
    groups.set(key, g);
  }
  const bizName = new Map(bizRows.map((b) => [b.id, b.name]));

  for (const recipient of groups.values()) {
    result.recipients += 1;
    await withSystemContext(async (tx) => {
      // Two ticks racing: the second waits here, then sees the first one's message.
      await tx
        .select({ id: businesses.id })
        .from(businesses)
        .where(inArray(businesses.id, recipient.businessIds))
        .orderBy(businesses.id)
        .for("update");
      if (await sentRecently(tx, recipient.userId, now)) {
        result.skippedRecent += 1;
        return;
      }
      const lines = await dueLines(tx, recipient.businessIds, bizName, now, new Set(opts.skipIds ?? []));
      const ids = lines.flatMap((l) => l.exceptionIds);
      result.due += ids.length;
      if (!lines.length) return;
      const text = digestText(lines);
      result.texts.push(text);
      if (opts.dryRun) result.allLines = [...(result.allLines ?? []), ...lines.map(lineFor)];
      result.raised += ids.length;
      result.sent += 1;
      if (opts.dryRun) return;
      const lineBusinesses = [...new Set(lines.map((l) => l.businessId))];
      await sendAlphaEvent(tx, {
        type: "owner.question",
        businessId: lineBusinesses.length === 1 ? lineBusinesses[0] : null,
        orderId: null,
        toUserId: recipient.userId,
        toRole: recipient.userId ? null : "admin",
        text,
        payload: { source: DIGEST_SOURCE, exceptionIds: ids, count: lines.length },
      });
      await tx
        .update(exceptions)
        .set({
          detail: sql`coalesce(${exceptions.detail}, '{}'::jsonb) || jsonb_build_object(
            'escalatedAt', ${now.toISOString()}::text,
            'escalations', coalesce((${exceptions.detail}->>'escalations')::int, 0) + 1)`,
        })
        .where(and(inArray(exceptions.id, ids), eq(exceptions.status, "open")));
    });
  }
  return result;
}

async function sentRecently(tx: Tx, userId: string | null, now: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: alphaEvents.id })
    .from(alphaEvents)
    .where(
      and(
        eq(alphaEvents.type, "owner.question"),
        sql`${alphaEvents.payload}->>'source' = ${DIGEST_SOURCE}`,
        userId ? eq(alphaEvents.toUserId, userId) : and(isNull(alphaEvents.toUserId), eq(alphaEvents.toRole, "admin")),
        gte(alphaEvents.createdAt, new Date(now.getTime() - DIGEST_EVERY_MINUTES * 60_000)),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Every open row that may be raised (the digest's) or worked (the agent's,
 * ./needs-you-desk.ts): legacy-quiet orders and finished orders left out, as below.
 */
export async function openRaisableRows(tx: Tx, businessIds: string[]) {
  if (!businessIds.length) return [];
  return tx
    .select({
      id: exceptions.id,
      businessId: exceptions.businessId,
      orderId: exceptions.orderId,
      kind: exceptions.kind,
      summary: exceptions.summary,
      detail: exceptions.detail,
      createdAt: exceptions.createdAt,
      number: sql<string | null>`coalesce(${orders.platformOrderName}, ${orders.platformOrderId})`,
      shopName: shops.name,
      orderStatus: sql<string | null>`${orders.status}::text`,
      revisions: orders.revisionCount,
    })
    .from(exceptions)
    .leftJoin(orders, eq(orders.id, exceptions.orderId))
    .leftJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        inArray(exceptions.businessId, businessIds),
        eq(exceptions.status, "open"),
        // LEGACY QUIET (owner, 2026-10-17): a legacy order its buyer has not reached out
        // on raises nothing, a row an earlier tick opened included; her own mail still does.
        or(isNull(exceptions.orderId), inArray(exceptions.kind, ["reply_unclear", "buyer_question", "unmatched_reply", "legacy_order"]), sql`not ${legacyQuiet()}`),
        // A tick that ran out of time may not have closed these yet; never raise them.
        or(
          isNull(exceptions.orderId),
          and(isNull(orders.archivedAt), notInArray(sql`${orders.status}::text`, CLOSED_STATUSES)),
          // A buyer writing about a finished order is new work: the L1 pass keeps
          // it open (./limbo.ts staleReason), so the owner hears about it.
          and(
            inArray(exceptions.kind, ["reply_unclear", "buyer_question", "email_send_failed", "legacy_order"]),
            sql`not (coalesce(${orders.archivedAt} >= ${exceptions.createdAt}, false) or exists (
              select 1 from activity_log a where a.order_id = ${orders.id}
                and a.to_state = ${orders.status} and a.created_at >= ${exceptions.createdAt}))`,
          ),
        ),
      ),
    );
}

export type RaisableRow = Awaited<ReturnType<typeof openRaisableRows>>[number];

/** The row as ./needs-you.ts reads it. */
export function needsYouInput(r: RaisableRow) {
  const detail = (r.detail ?? {}) as Record<string, unknown>;
  const ask = detail.ownerAsk;
  return {
    kind: r.kind,
    summary: r.summary,
    recommendation: typeof detail.recommendation === "string" ? detail.recommendation : null,
    said: typeof detail.excerpt === "string" ? buyerWords(detail.excerpt, 4000) : null,
    reason: typeof detail.reason === "string" ? detail.reason : null,
    orderStatus: r.orderStatus,
    revisions: r.revisions,
    ownerAsk: ask && typeof ask === "object" ? (ask as { kinds?: unknown; note?: unknown }) : null,
  };
}

async function dueLines(
  tx: Tx,
  businessIds: string[],
  bizName: Map<string, string>,
  now: Date,
  skip: Set<string>,
): Promise<DigestLine[]> {
  const rows = await openRaisableRows(tx, businessIds);

  const firstShop = await firstShopLabels(tx, businessIds);
  const lines: DigestLine[] = [];
  for (const r of rows) {
    if (skip.has(r.id)) continue;
    const detail = (r.detail ?? {}) as Record<string, unknown>;
    const candidate: DigestCandidate = {
      kind: r.kind,
      createdAt: r.createdAt,
      escalatedAt: typeof detail.escalatedAt === "string" ? detail.escalatedAt : null,
      escalations: typeof detail.escalations === "number" ? detail.escalations : 0,
      emailOnly: onlyEmailMissing(r.kind, detail),
    };
    // NEEDS YOU (Yousif 2026-10-17): only an upset buyer, money back, a legal threat
    // (or a revision only an owner may move) is the owner's. A thank-you is closed by
    // the tick; the rest is mine, and reaches the owner only if I never took it,
    // stopped, or could not finish it.
    const road = roadOf(needsYouInput(r));
    if (road.road === "close") continue;
    const agent = agentStateOf(detail);
    let fallbackNote: string | null = null;
    if (road.road === "agent") {
      const why = agentFallback(r.createdAt, graceHours(candidate) ?? 0, agent, now);
      if (!why) continue;
      // Stalled or out of goes: the owner gets where it got to, if anywhere.
      if (agent.note) fallbackNote = `I tried ${agent.takes} ${agent.takes === 1 ? "time" : "times"}: ${agent.note}`;
    }
    if (!isDue(candidate, now)) continue;
    const ask = detail.ownerAsk as { note?: unknown } | undefined;
    const askNote = road.road === "owner" && typeof ask?.note === "string" && ask.note.trim() ? ask.note : null;
    lines.push({
      exceptionId: r.id,
      exceptionIds: [r.id],
      groupKey: r.orderId ?? (typeof detail.from === "string" ? detail.from.toLowerCase() : r.summary),
      businessId: r.businessId,
      kind: r.kind,
      shop: r.shopName ? shortShopLabel(r.shopName) : (firstShop.get(r.businessId) ?? bizName.get(r.businessId) ?? ""),
      number: r.orderId ? r.number : null,
      summary: candidate.emailOnly ? EMAIL_ONLY_WORDS.summary : r.summary,
      recommendation:
        askNote ??
        fallbackNote ??
        (road.tags.includes("revision") && road.tags.length === 1
          ? REVISION_WORDS
          : candidate.emailOnly
            ? EMAIL_ONLY_WORDS.recommendation
            : typeof detail.recommendation === "string"
              ? detail.recommendation
              : ""),
      said: MAIL_KINDS.includes(r.kind) ? buyerWords(detail.excerpt) : null,
      link: r.orderId ? appUrl(`/orders/${r.orderId}`) : appUrl("/exceptions"),
      createdAt: r.createdAt,
      tags: road.tags.length ? road.tags : undefined,
    });
  }
  return sortLines(mergeLines(lines));
}

/** A business's short label from its first shop ("CPS Etsy" -> "CPS"), for rows with no order. */
async function firstShopLabels(tx: Tx, businessIds: string[]): Promise<Map<string, string>> {
  const rows = await tx
    .select({ businessId: shops.businessId, name: shops.name })
    .from(shops)
    .where(inArray(shops.businessId, businessIds))
    .orderBy(shops.name);
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.businessId)) out.set(r.businessId, shortShopLabel(r.name));
  return out;
}
