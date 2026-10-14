import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, assets, proofs } from "@/lib/db/schema";
import { getOrderPortraits, slotKeyOf, type OrderPortrait } from "@/lib/orders/portraits";
import type { OrderStatus } from "@/lib/orders/transitions";

/**
 * Which upload stands for which portrait, and so which files a proof email
 * carries (two portraits in one email, 2026-10-14; 4199589633, where the dog
 * was uploaded but only the cat ever showed, 2026-10-14). Pure choice logic
 * plus one loader. A single-portrait order keeps today's choice (the newest
 * upload); an order with 2+ portraits gets one file per portrait, and every
 * portrait without one is named in `missing`.
 */

/** One live submission/final upload, as far as the choice needs it. */
export type ProofFileRow = {
  id: string;
  type: string;
  /** ISO timestamp. */
  createdAt: string;
  /** assets.order_item_id: the order line the upload is tagged to; null = not tagged. */
  orderItemId: string | null;
  /**
   * assets.portrait_unit: which unit of that line. Null = not said, which is
   * every upload made before units counted: on a line that holds one portrait
   * it is that portrait, on a line of 2+ it could be any of them.
   */
  portraitUnit: number | null;
};

/** A file picked for the email, with the portrait it stands for. */
export type ProofFile = {
  assetId: string;
  /** 1-based portrait number (the slot's n). */
  n: number;
  label: string;
  /** The current portrait slot the file stands for; null only on a single-portrait order's untagged file. */
  slotKey: string | null;
  /**
   * tag = the uploader (or an earlier proof email) said which portrait it is;
   * order = matched by upload order (untagged, or tagged only to a line that
   * holds several portraits).
   */
  matched: "tag" | "order";
};

/** A portrait with no file yet. */
export type MissingPortrait = { n: number; key: string; label: string };

export type ProofFilePick = {
  /** How many portraits the email should carry: max(1, slots). */
  expected: number;
  /** single = one portrait, the newest upload (today's email); slots = one file per portrait. */
  mode: "single" | "slots";
  /** Picked files in portrait order. */
  files: ProofFile[];
  /** Portraits with no file (2+ portrait orders only; a single portrait is covered by its upload rule). */
  missing: MissingPortrait[];
  /** Every live upload matched to a portrait, asset id -> portrait n (2+ portrait orders only). */
  slotOf: Record<string, number>;
  /** Every live submission/final asset id of the order, newest first. */
  candidates: string[];
  /** When the current design round began (ISO), or null when it never restarted. */
  roundStartedAt: string | null;
  /** What a reviewer should know before sending; empty when the pick is clean. */
  warnings: string[];
};

/** A send-back from any of these into in_design starts a new round of design work. */
const ROUND_RESTART_FROM: OrderStatus[] = [
  "awaiting_qc",
  "awaiting_approval",
  "approved",
  "printing",
  "shipped",
  "delivered",
  "complete",
];

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Oldest first; equal timestamps (one batch insert shares one) fall back to the id so the order is stable. */
const byAge = (a: ProofFileRow, b: ProofFileRow): number =>
  time(a.createdAt) - time(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** [2] -> "Portrait 2"; [2, 3] -> "Portraits 2 and 3"; [1, 2, 5] -> "Portraits 1, 2 and 5". */
export function portraitList(ns: number[]): string {
  if (ns.length === 1) return `Portrait ${ns[0]}`;
  return `Portraits ${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
}

/**
 * The default files for an order's proof email (pure).
 *
 * - One portrait slot: the newest upload, nothing else. This is the same file
 *   the QC email attaches today (newest final/submission by created_at, a final
 *   gets no preference).
 * - 2+ slots: each portrait takes its newest upload tagged to it (a tag to a
 *   line that holds one portrait, or a line plus unit, or the portrait an
 *   earlier proof email pinned the file to). Portraits nobody tagged are filled
 *   from the loose uploads by upload order: files tagged only to a multi-unit
 *   line fill that line first, untagged files fill what is left, newest files
 *   of the current round first (topped up from earlier rounds). Any portrait
 *   still empty is `missing`.
 */
export function pickDefaultProofFiles(input: {
  slots: OrderPortrait[];
  files: ProofFileRow[];
  roundStartedAt: string | null;
  /** Asset id -> slot key from the latest proof email that pinned its files (proofs.files). */
  pinned?: Record<string, string>;
}): ProofFilePick {
  const { roundStartedAt } = input;
  const slots = [...input.slots].sort((a, b) => a.n - b.n);
  const expected = Math.max(1, slots.length);
  const oldestFirst = [...input.files].sort(byAge);
  const candidates = [...oldestFirst].reverse().map((f) => f.id);
  const pick = (
    mode: ProofFilePick["mode"],
    files: ProofFile[],
    warnings: string[],
    missing: MissingPortrait[] = [],
    slotOf: Record<string, number> = {},
  ): ProofFilePick => ({ expected, mode, files, missing, slotOf, candidates, roundStartedAt, warnings });
  const labelOf = (s: OrderPortrait) => s.label || `Portrait ${s.n}`;

  if (expected === 1) {
    if (!oldestFirst.length) return pick("single", [], ["No artwork uploaded yet."]);
    const newest = oldestFirst[oldestFirst.length - 1];
    const key = slotKeyOf(newest);
    return pick(
      "single",
      [
        {
          assetId: newest.id,
          n: slots[0]?.n ?? 1,
          label: slots[0]?.label || "Portrait",
          slotKey: key && key === slots[0]?.key ? key : null,
          matched: key && key === slots[0]?.key ? "tag" : "order",
        },
      ],
      [],
    );
  }

  const slotByKey = new Map(slots.map((s) => [s.key, s]));
  const slotsOfLine = new Map<string, OrderPortrait[]>();
  for (const s of slots) slotsOfLine.set(s.itemId, [...(slotsOfLine.get(s.itemId) ?? []), s]);

  // Sort every upload into "tagged to this portrait" or "loose" (with the line it is limited to, if any).
  const tagged = new Map<string, ProofFileRow[]>();
  const loose: { file: ProofFileRow; line: string | null }[] = [];
  for (const f of oldestFirst) {
    const lineSlots = f.orderItemId ? slotsOfLine.get(f.orderItemId) : undefined;
    let own: OrderPortrait | undefined;
    if (lineSlots) {
      own =
        f.portraitUnit != null
          ? lineSlots.find((s) => s.unit === f.portraitUnit)
          : lineSlots.length === 1
            ? lineSlots[0]
            : undefined;
    }
    const pinnedKey = input.pinned?.[f.id];
    if (!own && pinnedKey) {
      const pinnedSlot = slotByKey.get(pinnedKey);
      // A pin never moves a file to another line than the one it is tagged to.
      if (pinnedSlot && (!lineSlots || pinnedSlot.itemId === f.orderItemId)) own = pinnedSlot;
    }
    if (own) tagged.set(own.key, [...(tagged.get(own.key) ?? []), f]);
    else loose.push({ file: f, line: lineSlots ? f.orderItemId : null });
  }

  const chosen = new Map<string, { file: ProofFileRow; matched: ProofFile["matched"] }>();
  const slotOf: Record<string, number> = {};
  for (const s of slots) {
    const mine = tagged.get(s.key) ?? [];
    for (const f of mine) slotOf[f.id] = s.n;
    if (mine.length) chosen.set(s.key, { file: mine[mine.length - 1], matched: "tag" });
  }

  // Loose uploads fill the portraits nobody tagged, in upload order.
  const start = roundStartedAt ? time(roundStartedAt) : null;
  const used = new Set<string>();
  const fill = (open: OrderPortrait[], pool: ProofFileRow[]) => {
    const free = pool.filter((f) => !used.has(f.id));
    if (!open.length || !free.length) return;
    const fresh = start == null ? free : free.filter((f) => time(f.createdAt) > start);
    const older = start == null ? [] : free.filter((f) => time(f.createdAt) <= start);
    const take = fresh.slice(-open.length);
    const short = open.length - take.length;
    if (short > 0 && older.length) take.unshift(...older.slice(-short));
    take.forEach((f, i) => {
      chosen.set(open[i].key, { file: f, matched: "order" });
      slotOf[f.id] = open[i].n;
      used.add(f.id);
    });
  };
  for (const [line, lineSlots] of slotsOfLine) {
    fill(
      lineSlots.filter((s) => !chosen.has(s.key)),
      loose.filter((l) => l.line === line).map((l) => l.file),
    );
  }
  fill(
    slots.filter((s) => !chosen.has(s.key)),
    loose.filter((l) => l.line === null).map((l) => l.file),
  );

  const files: ProofFile[] = [];
  const missing: MissingPortrait[] = [];
  for (const s of slots) {
    const c = chosen.get(s.key);
    if (c) files.push({ assetId: c.file.id, n: s.n, label: labelOf(s), slotKey: s.key, matched: c.matched });
    else missing.push({ n: s.n, key: s.key, label: labelOf(s) });
  }

  const warnings: string[] = [];
  if (!oldestFirst.length) warnings.push("No artwork uploaded yet.");
  else if (missing.length) {
    warnings.push(`${portraitList(missing.map((m) => m.n))} ${missing.length === 1 ? "has" : "have"} no file yet.`);
  }
  // Matching by upload order is a guess when the portraits are of different lines (Loki vs Pisuca).
  const byOrder = files.filter((f) => f.matched === "order");
  if (new Set(byOrder.map((f) => slotByKey.get(f.slotKey!)?.itemId)).size > 1) {
    warnings.push(
      `${portraitList(byOrder.map((f) => f.n))} were matched to their files by upload order. Check each file is the right portrait.`,
    );
  }
  const leftOut = loose.filter((l) => !used.has(l.file.id) && (start == null || time(l.file.createdAt) > start)).length;
  if (leftOut) warnings.push(`${leftOut} more untagged file${leftOut === 1 ? " is" : "s are"} not in this email.`);
  return pick("slots", files, warnings, missing, slotOf);
}

/**
 * Load the inputs and make the default choice for one order. Runs inside the
 * caller's transaction under its own RLS role: staff and the assigned designer
 * can read the order's assets, items, proofs and activity_log alike, so nobody
 * needs a fallback. A caller that already loaded the order's slots passes them in.
 */
export async function loadProofFilePick(tx: Tx, orderId: string, loadedSlots?: OrderPortrait[]): Promise<ProofFilePick> {
  const slots = loadedSlots ?? (await getOrderPortraits(tx, orderId));
  const rows = await tx
    .select({
      id: assets.id,
      type: assets.type,
      createdAt: assets.createdAt,
      orderItemId: assets.orderItemId,
      portraitUnit: assets.portraitUnit,
    })
    .from(assets)
    .where(and(eq(assets.orderId, orderId), inArray(assets.type, ["submission", "final"]), isNull(assets.deletedAt)))
    .orderBy(asc(assets.createdAt), asc(assets.id));
  const [restart] = await tx
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.orderId, orderId),
        eq(activityLog.toState, "in_design"),
        inArray(activityLog.fromState, ROUND_RESTART_FROM),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  let pinned: Record<string, string> | undefined;
  if (slots.length >= 2) {
    const [lastPinned] = await tx
      .select({ files: proofs.files })
      .from(proofs)
      .where(and(eq(proofs.orderId, orderId), isNotNull(proofs.files)))
      .orderBy(desc(proofs.createdAt))
      .limit(1);
    pinned = pinnedSlots(lastPinned?.files);
  }
  return pickDefaultProofFiles({
    slots,
    files: rows.map((r) => ({
      id: r.id,
      type: r.type,
      createdAt: r.createdAt.toISOString(),
      orderItemId: r.orderItemId,
      portraitUnit: r.portraitUnit,
    })),
    roundStartedAt: restart ? restart.createdAt.toISOString() : null,
    pinned,
  });
}

/** proofs.files (what an email carried) -> asset id -> slot key, ignoring anything malformed. */
export function pinnedSlots(files: unknown): Record<string, string> | undefined {
  if (!Array.isArray(files)) return undefined;
  const out: Record<string, string> = {};
  for (const f of files) {
    const assetId = f && typeof f === "object" ? (f as { assetId?: unknown }).assetId : null;
    const slotKey = f && typeof f === "object" ? (f as { slotKey?: unknown }).slotKey : null;
    if (typeof assetId === "string" && typeof slotKey === "string" && slotKey) out[assetId] = slotKey;
  }
  return Object.keys(out).length ? out : undefined;
}
