// Trello board -> AlphaOS orders (docs/trello-transition.md).
//
//   npx tsx scripts/import-trello.ts --business "<name or id>" --file board.json [--dry-run]
//   TRELLO_KEY=... TRELLO_TOKEN=... npx tsx scripts/import-trello.ts --business "<name or id>" --board <boardId> [--dry-run]
//
// A card becomes one order (source 'trello', trello card id stored on it, so a
// second run skips it). Runs against whatever DATABASE_URL points at: use
// --dry-run first.
import "./load-env";

import { eq, sql } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { businesses, orders, shops } from "../lib/db/schema";

// ---------------------------------------------------------------------------
// EDIT ME: which Trello list means which AlphaOS stage.
// Keys are lower-cased list names (matched exactly, then by "contains").
// "skip" leaves the card out. Lists not named here use DEFAULT_STAGE.
// ---------------------------------------------------------------------------
export type Stage = "awaiting_details" | "awaiting_photos" | "ready_to_assign" | "in_design" | "awaiting_qc" | "awaiting_approval" | "complete" | "on_hold" | "skip";

export const LIST_TO_STAGE: Record<string, Stage> = {
  "new orders": "awaiting_details",
  "to do": "awaiting_details",
  "waiting for photos": "awaiting_photos",
  "in progress": "in_design",
  "drawing": "in_design",
  "review": "awaiting_qc",
  "sent for approval": "awaiting_approval",
  "done": "complete",
  "shipped": "complete",
  "on hold": "on_hold",
  "archive": "skip",
};
export const DEFAULT_STAGE: Stage = "awaiting_details";
// ---------------------------------------------------------------------------

export type TrelloCard = {
  id: string;
  name: string;
  desc?: string;
  due?: string | null;
  closed?: boolean;
  idList: string;
  labels?: { name?: string; color?: string }[];
  attachments?: { name?: string; url?: string }[];
};
export type TrelloBoard = { name?: string; lists: { id: string; name: string; closed?: boolean }[]; cards: TrelloCard[] };

export type PlannedOrder = {
  cardId: string;
  orderNumber: string;
  list: string;
  stage: Stage;
  dueAt: Date | null;
  notes: string;
};

export function stageForList(listName: string, map: Record<string, Stage> = LIST_TO_STAGE): Stage {
  const key = listName.trim().toLowerCase();
  if (map[key]) return map[key];
  const hit = Object.keys(map).find((k) => key.includes(k));
  return hit ? map[hit] : DEFAULT_STAGE;
}

/** Card fields as the order's note: description, labels, attachment links. */
export function cardNotes(card: TrelloCard): string {
  const parts: string[] = [];
  if (card.desc?.trim()) parts.push(card.desc.trim());
  const labels = (card.labels ?? []).map((l) => l.name || l.color).filter(Boolean);
  if (labels.length) parts.push(`Trello labels: ${labels.join(", ")}`);
  for (const a of card.attachments ?? []) if (a.url) parts.push(`Attachment: ${a.name ? a.name + " " : ""}${a.url}`);
  return parts.join("\n\n");
}

export function planImport(board: TrelloBoard, map: Record<string, Stage> = LIST_TO_STAGE): { plan: PlannedOrder[]; skipped: { cardId: string; reason: string }[] } {
  const listName = new Map(board.lists.map((l) => [l.id, l.name]));
  const plan: PlannedOrder[] = [];
  const skipped: { cardId: string; reason: string }[] = [];
  for (const card of board.cards) {
    if (card.closed) {
      skipped.push({ cardId: card.id, reason: "archived card" });
      continue;
    }
    const list = listName.get(card.idList) ?? "";
    const stage = stageForList(list, map);
    if (stage === "skip") {
      skipped.push({ cardId: card.id, reason: `list "${list}" is mapped to skip` });
      continue;
    }
    const due = card.due ? new Date(card.due) : null;
    plan.push({
      cardId: card.id,
      orderNumber: card.name.trim().slice(0, 120) || card.id,
      list,
      stage,
      dueAt: due && !Number.isNaN(due.getTime()) ? due : null,
      notes: cardNotes(card),
    });
  }
  return { plan, skipped };
}

async function fetchBoard(boardId: string, key: string, token: string): Promise<TrelloBoard> {
  const q = `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
  const get = async (path: string) => {
    const res = await fetch(`https://api.trello.com/1/${path}${path.includes("?") ? "&" : "?"}${q}`);
    if (!res.ok) throw new Error(`Trello ${path.split("?")[0]} answered ${res.status}`);
    return res.json();
  };
  const [lists, cards] = await Promise.all([
    get(`boards/${boardId}/lists?filter=open`),
    get(`boards/${boardId}/cards/open?attachments=true&fields=id,name,desc,due,closed,idList,labels`),
  ]);
  return { lists, cards };
}

async function loadBoard(args: { file?: string; board?: string }): Promise<TrelloBoard> {
  if (args.file) {
    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile(args.file, "utf8"));
    // A Trello export nests attachments per card already; some exports use "actions" only.
    return { name: json.name, lists: json.lists ?? [], cards: json.cards ?? [] };
  }
  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!args.board || !key || !token) throw new Error("Give --file <export.json>, or --board <id> with TRELLO_KEY and TRELLO_TOKEN set");
  return fetchBoard(args.board, key, token);
}

export type ImportResult = { created: number; alreadyImported: number; skipped: number; lines: string[] };

export async function runImport(opts: { business: string; board: TrelloBoard; dryRun: boolean; map?: Record<string, Stage> }): Promise<ImportResult> {
  const { plan, skipped } = planImport(opts.board, opts.map);
  const lines: string[] = [];
  return withSystemContext(async (tx) => {
    const [biz] = await tx
      .select({ id: businesses.id, name: businesses.name })
      .from(businesses)
      .where(sql`${businesses.id}::text = ${opts.business} or lower(${businesses.name}) = ${opts.business.toLowerCase()}`)
      .limit(1);
    if (!biz) throw new Error(`No business "${opts.business}"`);
    const [shop] = await tx
      .select({ id: shops.id })
      .from(shops)
      .where(sql`${shops.businessId} = ${biz.id} and ${shops.active} = true`)
      .orderBy(sql`case when ${shops.platform} = 'etsy' then 0 else 1 end`, shops.createdAt)
      .limit(1);
    if (!shop) throw new Error(`Business "${biz.name}" has no active shop to attach orders to`);

    const have = new Set(
      (await tx.select({ id: orders.trelloCardId }).from(orders).where(eq(orders.businessId, biz.id)))
        .map((r) => r.id)
        .filter((x): x is string => !!x),
    );
    let created = 0;
    let already = 0;
    for (const p of plan) {
      if (have.has(p.cardId)) {
        already += 1;
        lines.push(`skip   ${p.cardId}  already imported  "${p.orderNumber}"`);
        continue;
      }
      lines.push(`${opts.dryRun ? "would " : ""}create ${p.cardId}  "${p.orderNumber}"  list="${p.list}" -> ${p.stage}${p.dueAt ? "  due " + p.dueAt.toISOString().slice(0, 10) : ""}`);
      if (opts.dryRun) {
        created += 1;
        continue;
      }
      const ins = await tx
        .insert(orders)
        .values({
          businessId: biz.id,
          shopId: shop.id,
          platformOrderId: `trello-${p.cardId}`,
          platformOrderName: p.orderNumber,
          source: "trello",
          status: p.stage === "skip" ? "awaiting_details" : p.stage,
          trelloCardId: p.cardId,
          dueAt: p.dueAt,
          notes: p.notes || null,
          needsReview: true,
          uploadToken: crypto.randomUUID(),
          rawImport: { trello: { cardId: p.cardId, list: p.list } },
        })
        .onConflictDoNothing()
        .returning({ id: orders.id });
      if (ins.length) created += 1;
      else already += 1;
    }
    for (const s of skipped) lines.push(`skip   ${s.cardId}  ${s.reason}`);
    return { created, alreadyImported: already, skipped: skipped.length, lines };
  });
}

function parseArgs(argv: string[]) {
  const out: { file?: string; board?: string; business?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--board") out.board = argv[++i];
    else if (a === "--business") out.business = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.business) throw new Error('Usage: tsx scripts/import-trello.ts --business "<name or id>" (--file board.json | --board <id>) [--dry-run]');
  const board = await loadBoard(args);
  const res = await runImport({ business: args.business, board, dryRun: args.dryRun });
  console.log(res.lines.join("\n"));
  console.log(`${args.dryRun ? "DRY RUN: " : ""}${res.created} ${args.dryRun ? "would be created" : "created"}, ${res.alreadyImported} already imported, ${res.skipped} skipped`);
}

if (process.argv[1]?.endsWith("import-trello.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
