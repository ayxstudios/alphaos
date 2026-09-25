/**
 * Render every customer email template to HTML files for a visual check, with
 * the app's own renderer (renderTemplate + textToHtml + the From header), no
 * database and no sending. Sample values include a hostile customer name so
 * escaping can be checked in the output. Usage:
 *   npx tsx scripts/email-preview.ts [outDir]   (default var/email-preview)
 * Writes <outDir>/<business>-<key>.html plus an index.html, and prints one
 * line per template: subject, unresolved {{vars}} (none expected), link count.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_TEMPLATES, EDITABLE_TEMPLATE_KEYS, TEMPLATE_META, defaultTemplateForBusiness, renderTemplate, type TemplateKey } from "../lib/email/templates";
import { formatFromHeader, textToHtml } from "../lib/integrations/gmail/mime";
import { proofUrl, uploadUrl } from "../lib/urls";

const outDir = path.resolve(process.argv[2] ?? "var/email-preview");
mkdirSync(outDir, { recursive: true });

const businesses = [
  { slug: "pixart", name: "PixArt", address: "hello@example.com" },
  { slug: "other", name: "The Custom Portrait Shop", address: "orders@example.com" },
];

const vars = {
  first_name: '<b>Ann & "Bo"</b>',
  order_number: "PC32148",
  proof_link: proofUrl("EXAMPLE_PROOF_TOKEN_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
  upload_link: uploadUrl("00000000-0000-4000-8000-000000000000"),
  tracking_number: "1Z999AA10123456784",
  tracking_url: "https://www.ups.com/track?tracknum=1Z999AA10123456784",
};

const keys: TemplateKey[] = [...EDITABLE_TEMPLATE_KEYS, "proof_ready"];
const rows: string[] = [];
let problems = 0;
for (const business of businesses) {
  for (const key of keys) {
    const template = defaultTemplateForBusiness(business, key);
    const rendered = renderTemplate(template, { ...vars, business_name: business.name });
    const html = textToHtml(rendered.body);
    const from = formatFromHeader(business.name, business.address);
    const leftover = [...rendered.subject.matchAll(/\{\{[^}]*\}\}/g), ...rendered.body.matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0]);
    const links = html.match(/<a [^>]*>/g) ?? [];
    const relative = links.filter((a) => !/href="https?:\/\//.test(a));
    const rawTag = html.includes("<b>") || html.includes("<script");
    const ok = leftover.length === 0 && relative.length === 0 && !rawTag;
    if (!ok) problems += 1;
    const file = `${business.slug}-${key}.html`;
    writeFileSync(
      path.join(outDir, file),
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${key}</title></head><body style="margin:0;background:#eee"><div style="font:12px/16px monospace;padding:8px;background:#fff;border-bottom:1px solid #ccc">From: ${escape(from)}<br>Subject: ${escape(rendered.subject)}</div><div style="padding:8px;background:#fff">${html}</div><hr><pre style="white-space:pre-wrap;font:12px/16px monospace;padding:8px;background:#fff">${escape(rendered.body)}</pre></body></html>`,
    );
    rows.push(`<li><a href="${file}">${business.name}: ${TEMPLATE_META[key].label}</a> ${ok ? "ok" : "PROBLEM"}</li>`);
    console.log(
      `${ok ? "ok     " : "PROBLEM"} ${business.slug}/${key}: subject="${rendered.subject}" leftover=${leftover.length} links=${links.length} relative=${relative.length} rawTag=${rawTag}`,
    );
  }
}
writeFileSync(path.join(outDir, "index.html"), `<!doctype html><meta charset="utf-8"><ul>${rows.join("")}</ul>`);
console.log(`${businesses.length * keys.length} rendered to ${outDir}${problems ? `, ${problems} with problems` : ""}`);
console.log(`Templates in code: ${Object.keys(DEFAULT_TEMPLATES).length} (${keys.length} rendered per business)`);
process.exit(problems ? 1 : 0);

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
