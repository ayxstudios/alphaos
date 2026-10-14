/**
 * One-off heal (2026-10-14): Etsy order items imported as physical only because
 * Etsy's is_digital=false meant "not a download listing". Re-runs the corrected
 * import rule on each stored receipt and flips physical -> digital when there is
 * no positive physical evidence. Never touches an order that already has a print
 * job. Usage: DATABASE_URL=... tsx scripts/heal-etsy-product-type.ts [--apply]
 */
import { neon } from "@neondatabase/serverless";
import fs from "node:fs";
import { etsyImportItems } from "../lib/integrations/etsy/receipt-review";

async function main() {
const sql = neon(process.env.DATABASE_URL!);
const apply = process.argv.includes("--apply");
const rows: any[] = await sql.query(
  `select oi.id item_id, oi.title, oi.sku, o.id order_id, o.platform_order_id pid, o.status, o.raw_import,
          exists (select 1 from print_jobs pj where pj.order_id = o.id) has_print
     from order_items oi join orders o on o.id = oi.order_id
    where o.source = 'etsy' and oi.product_type = 'physical'`,
);
const flips: any[] = [];
let kept = 0, skippedPrint = 0;
for (const r of rows) {
  const items = etsyImportItems(r.raw_import);
  const m = items.find((i) => (i.sku || "") === (r.sku || "") && (i.title || "") === (r.title || "")) ?? (items.length === 1 ? items[0] : null);
  if (!m) { kept++; continue; }
  if (m.productType === "physical") { kept++; continue; }
  if (r.has_print) { skippedPrint++; continue; }
  flips.push({ item_id: r.item_id, pid: r.pid, status: r.status, title: String(r.title).slice(0, 50) });
}
const byStatus: Record<string, number> = {};
for (const f of flips) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
console.log({ scanned: rows.length, willFlip: flips.length, keptPhysical: kept, skippedHasPrintJob: skippedPrint, byStatus });
if (apply && flips.length) {
  fs.writeFileSync("var-heal-etsy-product-type-undo.json", JSON.stringify(flips.map((f) => f.item_id)));
  const ids = flips.map((f) => f.item_id);
  const res = await sql.query(`update order_items set product_type = 'digital' where id = any($1::text[]) and product_type = 'physical'`, [ids]);
  console.log("updated", (res as any).rowCount ?? "ok");
}
}
main().catch((e) => { console.error(e); process.exit(1); });
