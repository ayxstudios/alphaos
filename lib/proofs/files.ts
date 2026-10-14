import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, assets } from "@/lib/db/schema";
import { getOrderPortraits, slotKeyOf, type OrderPortrait } from "@/lib/orders/portraits";
import type { OrderStatus } from "@/lib/orders/transitions";

/**
 * Which files a proof email carries by default (two portraits in one email,
 * 2026-10-14). Pure choice logic plus one loader; nothing here sends or shows
 * anything yet. A single-portrait order keeps today's choice (the newest
 * upload); an order with 2+ portraits picks one file per portrait.
 */

/** One live submission/final upload, as far as the choice needs it. */
export type ProofFileRow = {
  id: string;
  type: string;
  /** ISO timestamp. */
  createdAt: string;
  /** slotKeyOf(order_item_id, portrait_unit); null = not tagged to a portrait. */
  slotKey: string | null;
};

/** A file picked for the email, with the portrait it stands for. */
export type ProofFile = {
  assetId: string;
  /** 1-based position of the portrait in the email (the slot number when tagged). */
  n: number;
  label: string;
  /** The current portrait slot the file is tagged to; null when it is not tagged to one. */
  slotKey: string | null;
};

export type ProofFilePick = {
  /** How many portraits the email should carry: max(1, slots). */
  expected: number;
  /**
   * single = one portrait, the newest upload (today's email); tagged = one file
   * per portrait from the designer's tags; round = untagged uploads of the
   * current round, one per portrait.
   */
  mode: "single" | "tagged" | "round";
  /** Picked files in email order. */
  files: ProofFile[];
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

/**
 * The default files for an order's proof email (pure).
 *
 * - One portrait slot: the newest upload, nothing else. This is the same file
 *   the QC email attaches today (newest final/submission by created_at, a final
 *   gets no preference).
 * - 2+ slots and some upload tagged to a current slot: per slot, its newest
 *   tagged upload. A slot with none is flagged; so are newer untagged uploads.
 * - 2+ slots and nothing tagged (how designers upload today): the newest
 *   uploads of the current round, one per slot, oldest first.
 */
export function pickDefaultProofFiles(input: {
  slots: OrderPortrait[];
  files: ProofFileRow[];
  roundStartedAt: string | null;
}): ProofFilePick {
  const { roundStartedAt } = input;
  const slots = [...input.slots].sort((a, b) => a.n - b.n);
  const expected = Math.max(1, slots.length);
  const oldestFirst = [...input.files].sort(byAge);
  const candidates = [...oldestFirst].reverse().map((f) => f.id);
  const slotKeys = new Set(slots.map((s) => s.key));
  /** The tag a file carries, but only when it names a slot this order has now. */
  const currentKey = (f: ProofFileRow) => (f.slotKey && slotKeys.has(f.slotKey) ? f.slotKey : null);
  const pick = (mode: ProofFilePick["mode"], files: ProofFile[], warnings: string[]): ProofFilePick => ({
    expected,
    mode,
    files,
    candidates,
    roundStartedAt,
    warnings,
  });

  if (!oldestFirst.length) {
    return pick(expected === 1 ? "single" : "round", [], ["No artwork uploaded yet."]);
  }

  if (expected === 1) {
    const newest = oldestFirst[oldestFirst.length - 1];
    return pick(
      "single",
      [{ assetId: newest.id, n: slots[0]?.n ?? 1, label: slots[0]?.label || "Portrait", slotKey: currentKey(newest) }],
      [],
    );
  }

  if (oldestFirst.some((f) => currentKey(f))) {
    const files: ProofFile[] = [];
    const warnings: string[] = [];
    let newestPicked = 0;
    for (const slot of slots) {
      const mine = oldestFirst.filter((f) => f.slotKey === slot.key);
      const newest = mine[mine.length - 1];
      const label = slot.label || `Portrait ${slot.n}`;
      if (!newest) {
        warnings.push(`${label} has no file yet.`);
        continue;
      }
      files.push({ assetId: newest.id, n: slot.n, label, slotKey: slot.key });
      newestPicked = Math.max(newestPicked, time(newest.createdAt));
    }
    const newerUntagged = oldestFirst.filter((f) => !currentKey(f) && time(f.createdAt) > newestPicked).length;
    if (newerUntagged) warnings.push(`${newerUntagged} newer untagged file(s) are not in this email.`);
    return pick("tagged", files, warnings);
  }

  // Nothing is tagged: the files of the current round, newest `expected` of them.
  let roundFiles = roundStartedAt ? oldestFirst.filter((f) => time(f.createdAt) > time(roundStartedAt)) : oldestFirst;
  if (!roundFiles.length) roundFiles = oldestFirst;
  const k = Math.min(expected, roundFiles.length);
  const files: ProofFile[] = roundFiles.slice(roundFiles.length - k).map((f, i) => ({
    assetId: f.id,
    n: i + 1,
    label: `Portrait ${i + 1}`,
    slotKey: null,
  }));
  const warnings: string[] = [];
  if (roundFiles.length < expected) {
    warnings.push(`Only ${k} of ${expected} portraits are new this round. Add the others below.`);
  } else if (roundFiles.length > expected) {
    warnings.push(`${roundFiles.length} files were uploaded this round for ${expected} portraits. The newest ${expected} are picked.`);
  }
  return pick("round", files, warnings);
}

/**
 * Load the inputs and make the default choice for one order. Runs inside the
 * caller's transaction under its own RLS role: staff and the assigned designer
 * can read the order's assets, items and activity_log alike, so nobody needs a
 * fallback. A caller that already loaded the order's slots passes them in.
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
  return pickDefaultProofFiles({
    slots,
    files: rows.map((r) => ({
      id: r.id,
      type: r.type,
      createdAt: r.createdAt.toISOString(),
      slotKey: slotKeyOf({ orderItemId: r.orderItemId, portraitUnit: r.portraitUnit }),
    })),
    roundStartedAt: restart ? restart.createdAt.toISOString() : null,
  });
}
