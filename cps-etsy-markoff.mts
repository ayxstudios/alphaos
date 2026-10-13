/**
 * CPS Etsy digital mark-off through the Etsy API (Yousif 2026-10-13: "mark them off like the VAs were doing").
 * Equivalent of the VAs' Complete order with no tracking: PUT receipt was_shipped=true (scope transactions_w).
 * List: scripts/cps-awaiting-audit.mjs markoff (digital, placed since 8 Oct, photos in or 24 h+ old), oldest first. Safety on the LIVE receipt:
 * already shipped = record "already"; Print & Ship listing 1231801819 or a print/canvas/framed variation = skip "physical".
 * Run from the alphaos worktree root: npx tsx ./cps-etsy-markoff.mts [--dry] [--limit N] [--only <receipt>]
 */
import "./scripts/load-env";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { withSystemContext } from "@/lib/db";
import { shops } from "@/lib/db/schema";
import { getShopCredentials } from "@/lib/db/credentials";
import { EtsyClient } from "@/lib/integrations/etsy/client";
import type { EtsyCredentials } from "@/lib/integrations/etsy/types";

const SHOP = "e3333400-c079-465c-81ab-695cd5955993";
const AGENT = "/Users/almacorp2/Documents/ai-employee-agent";
const TASKLOG = `${AGENT}/var/cps-live/MARKOFF-TASKLOG.md`;
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
const LIMIT = Number(opt("limit") || 999);
const ONLY = opt("only");

type Txn = { listing_id?: number; title?: string; variations?: { formatted_name?: string; formatted_value?: string }[] };
type Receipt = { receipt_id: number; is_shipped?: boolean; status?: string; transactions?: Txn[]; shipments?: unknown[] };
const physical = (t: Txn[] = []) => t.some((x) => String(x.listing_id) === "1231801819" || /print\s*&\s*ship/i.test(x.title || "") || (x.variations || []).some((v) => /print|canvas|framed|poster|physical/i.test(`${v.formatted_name || ""} ${v.formatted_value || ""}`)));

const { row, creds } = await withSystemContext(async (tx) => {
  const [row] = await tx.select({ id: shops.id, businessId: shops.businessId, externalShopId: shops.externalShopId }).from(shops).where(eq(shops.id, SHOP));
  const creds = (await getShopCredentials(tx, SHOP)) as EtsyCredentials;
  return { row, creds };
});
if (!row?.externalShopId || !/^\d+$/.test(String(row.externalShopId))) throw new Error(`no numeric etsy shop id on ${SHOP}`);
const client = new EtsyClient(SHOP, row.businessId, creds);
const etsyShop = String(row.externalShopId);

// Own ledger (brain-local): the dt-watch markoff record travels to the desk's driver over ssh, so the local watch-state
// cannot be trusted to know what was recorded; one record per receipt, ever.
const LEDGER = `${AGENT}/var/cps-live/markoff-api-ledger.json`;
let ledger: Record<string, { note: string; at: string }> = {}; try { ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch {}
const state = { markedOff: { ...JSON.parse(fs.readFileSync(`${AGENT}/var/cps-live/watch-state.json`, "utf8")).markedOff, ...ledger } };
// Live list from the audit (digital, placed since 8 Oct, photos in or 24 h+ old); the queue file is only the 13 Oct snapshot.
const audit = JSON.parse(execFileSync("node", ["scripts/cps-awaiting-audit.mjs"], { cwd: AGENT, encoding: "utf8", timeout: 60000 }).trim().split("\n").pop()!);
const queue: { n: string; buyer: string; hoursOld: number }[] = (audit.markoff as { n: string; buyer: string; hoursOld: number }[]).sort((a, b) => b.hoursOld - a.hoursOld);
const todo = queue.filter((o) => !state.markedOff?.[o.n] && (!ONLY || String(o.n) === ONLY)).slice(0, LIMIT);
const log = (line: string) => { console.log(line); if (!DRY) fs.appendFileSync(TASKLOG, `- ${line} ${new Date().toISOString().slice(11, 16)} UTC\n`); };
const record = (n: string, note: string) => { if (DRY) return; ledger[n] = { note, at: new Date().toISOString() }; fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1)); execFileSync("node", ["scripts/dt-watch.mjs", "--shop", "cps", "markoff", n, "--note", note], { cwd: AGENT, stdio: "pipe" }); };
const out = { done: [] as string[], already: [] as string[], physical: [] as string[], failed: [] as { n: string; why: string }[], dry: DRY, todo: todo.length };

for (const o of todo) {
  try {
    const r = await client.apiGet<Receipt>(`/shops/${etsyShop}/receipts/${o.n}`);
    const items = (r.transactions || []).map((t) => `${t.listing_id}:${(t.title || "").slice(0, 40)}${(t.variations || []).map((v) => ` [${v.formatted_name}=${v.formatted_value}]`).join("")}`).join(" | ");
    if (physical(r.transactions)) { out.physical.push(o.n); log(`${o.n} ${o.buyer} physical (kept open): ${items}`); record(o.n, "physical"); continue; }
    if (r.is_shipped) { out.already.push(o.n); log(`${o.n} ${o.buyer} already complete on Etsy: ${items}`); record(o.n, "already"); continue; }
    if (DRY) { log(`${o.n} ${o.buyer} WOULD mark off: ${items}`); continue; }
    const u = await client.apiPutForm<Receipt>(`/shops/${etsyShop}/receipts/${o.n}`, { was_shipped: true });
    if (u.is_shipped !== true) throw new Error(`PUT answered is_shipped=${String(u.is_shipped)}`);
    out.done.push(o.n); log(`${o.n} ${o.buyer} done (Etsy API was_shipped): ${items}`); record(o.n, "done");
  } catch (e) {
    const why = String((e as Error).message || e).slice(0, 200);
    out.failed.push({ n: o.n, why }); log(`${o.n} ${o.buyer} failed(${why})`);
  }
}
console.log(JSON.stringify(out));
process.exit(0);
