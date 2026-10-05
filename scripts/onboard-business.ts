/**
 * Generic business onboarding + baseline audit (Yousif 2026-10-06: every fix
 * is platform-level; no business should ever need the same improvement twice).
 *
 *   npx tsx scripts/onboard-business.ts audit            # baseline report, all businesses
 *   npx tsx scripts/onboard-business.ts audit <slug>     # one business
 *   npx tsx scripts/onboard-business.ts create --name "Acme Portraits" --slug acme \
 *       [--agent-from 2026-10-06T00:00:00Z] [--todo-from 2026-10-06T00:00:00Z] \
 *       [--sign-off "Warm regards,\nBrianna"]
 *
 * `create` inserts ONLY the business row, with every safety default off
 * (no email sending, no agent gates, no auto-send) and the go-live/to-do
 * cutoffs set so old orders never flood the queues. Everything else (Gmail
 * OAuth, shop connect, print creds, styles, designers) happens in Settings;
 * this script prints that checklist and `audit` verifies it was completed.
 * Idempotent: create refuses an existing slug, audit only reads.
 */
import "./load-env";

import { and, eq, inArray } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { AgentConfigInput } from "@/lib/agent/config-types";

type Check = { ok: boolean; label: string; detail?: string };

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function isoOrNull(v: string | null, flag: string): string | null {
  if (v == null) return null;
  if (Number.isNaN(Date.parse(v))) throw new Error(`--${flag} is not a valid ISO time: ${v}`);
  return new Date(v).toISOString();
}

async function auditOne(bizId: string): Promise<Check[]> {
  return withSystemContext(async (tx) => {
    const [b] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, bizId));
    const cfg = (b.agentConfig ?? {}) as AgentConfigInput;
    const shops = await tx
      .select({ platform: schema.shops.platform, name: schema.shops.name })
      .from(schema.shops)
      .where(eq(schema.shops.businessId, bizId));
    const styles = await tx
      .select({ name: schema.styles.name, rate: schema.styles.perFigureRate, isDefault: schema.styles.isDefault })
      .from(schema.styles)
      .where(eq(schema.styles.businessId, bizId));
    const designers = await tx
      .select({ userId: schema.designerBusinesses.userId })
      .from(schema.designerBusinesses)
      .where(eq(schema.designerBusinesses.businessId, bizId));
    const unpriced = styles.filter((s) => s.rate == null).map((s) => s.name);

    const checks: Check[] = [
      { ok: shops.length > 0, label: "shop connected", detail: shops.map((s) => `${s.name} (${s.platform})`).join(", ") || "none" },
      { ok: !!b.gmailAddress, label: "mailbox connected", detail: b.gmailAddress ?? "none" },
      { ok: b.emailSendingEnabled, label: "email sending on", detail: b.emailSendingEnabled ? "on" : "OFF (customer email will not send)" },
      { ok: !!b.printCredentials, label: "print credentials", detail: b.printCredentials ? "set" : "none (print jobs will block)" },
      { ok: styles.length > 0, label: "portrait styles", detail: `${styles.length} style(s)` },
      { ok: styles.some((s) => s.isDefault), label: "default style set", detail: styles.find((s) => s.isDefault)?.name ?? "none" },
      { ok: unpriced.length === 0, label: "every style priced", detail: unpriced.length ? `unpriced (pay blocks): ${unpriced.join(", ")}` : "all priced" },
      { ok: designers.length > 0, label: "designers linked", detail: `${designers.length} designer(s)` },
      { ok: cfg.agentFrom != null, label: "agentFrom cutoff", detail: cfg.agentFrom ?? "unset: agent would touch ALL history once enabled" },
      { ok: cfg.todoFrom != null || cfg.agentFrom != null, label: "todoFrom cutoff", detail: cfg.todoFrom ?? cfg.agentFrom ?? "unset: staff to-dos carry all history" },
      { ok: !!cfg.replySignOff, label: "reply sign-off persona", detail: cfg.replySignOff ?? "default team sign-off" },
      { ok: !!cfg.emailSignature, label: "email signature block", detail: cfg.emailSignature ? "set" : "none" },
    ];
    return checks;
  });
}

async function audit(slug: string | null) {
  const rows = await withSystemContext((tx) =>
    tx
      .select({ id: schema.businesses.id, name: schema.businesses.name, slug: schema.businesses.slug })
      .from(schema.businesses),
  );
  const targets = slug ? rows.filter((r) => r.slug === slug) : rows;
  if (slug && targets.length === 0) throw new Error(`no business with slug "${slug}"`);

  const team = await withSystemContext((tx) =>
    tx
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(and(eq(schema.users.active, true), inArray(schema.users.role, ["va", "admin"]))),
  );
  console.log(`Active VA/admin team (QC sign-off names, shared across businesses): ${team.length ? team.map((t) => t.name).join(", ") : "NONE — QC sign-off cannot unlock"}`);

  let failures = 0;
  for (const b of targets) {
    console.log(`\n== ${b.name} (${b.slug}) ==`);
    for (const c of await auditOne(b.id)) {
      if (!c.ok) failures += 1;
      console.log(`  ${c.ok ? "ok " : "!! "} ${c.label.padEnd(26)} ${c.detail ?? ""}`);
    }
  }
  console.log(`\n${failures === 0 ? "Baseline complete." : `${failures} item(s) to finish (each "!!" line above).`}`);
  if (failures > 0) process.exitCode = 1;
}

async function create() {
  const name = arg("name");
  const slug = arg("slug");
  if (!name || !slug) throw new Error("create needs --name and --slug");
  const agentFrom = isoOrNull(arg("agent-from") ?? new Date().toISOString(), "agent-from");
  const todoFrom = isoOrNull(arg("todo-from"), "todo-from") ?? agentFrom;
  const replySignOff = arg("sign-off");

  await withSystemContext(async (tx) => {
    const [existing] = await tx.select({ id: schema.businesses.id }).from(schema.businesses).where(eq(schema.businesses.slug, slug));
    if (existing) throw new Error(`slug "${slug}" already exists; nothing created`);
    const agentConfig: AgentConfigInput = { agentFrom, todoFrom, ...(replySignOff ? { replySignOff } : {}) };
    // Every switch that can reach a customer stays at its schema default (off).
    await tx.insert(schema.businesses).values({ name, slug, agentConfig });
  });

  console.log(`Created business "${name}" (${slug}). Cutoffs: agentFrom=${agentFrom}, todoFrom=${todoFrom}.`);
  console.log(`All customer-facing switches are OFF. Finish in Settings, then verify with:`);
  console.log(`  npx tsx scripts/onboard-business.ts audit ${slug}`);
  console.log(`Checklist: connect the shop(s); connect the business's own Gmail OAuth; add print credentials;`);
  console.log(`add portrait styles with per-figure rates + a default; link designers; set the reply persona and`);
  console.log(`email signature; review email templates (generic defaults apply until overridden); only then turn`);
  console.log(`on email sending / agent gates per docs/ONBOARDING.md.`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === "audit") return audit(process.argv[3]?.startsWith("--") ? null : (process.argv[3] ?? null));
  if (mode === "create") return create();
  throw new Error("usage: onboard-business.ts audit [slug] | create --name <name> --slug <slug> [--agent-from ISO] [--todo-from ISO] [--sign-off text]");
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
