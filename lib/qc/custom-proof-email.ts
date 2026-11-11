/**
 * One order's own proof email, written ahead instead of the template (Yousif
 * 2026-11-11, PixArt PC32231: an upset customer's full redraw goes out with a
 * big apology that asks if she still wants the print, not "Here's your
 * updated portrait!").
 *
 * An activity_log row carries it: `proof.custom_email_set` with
 * { subject, body, why?, by? } in metadata; `proof.custom_email_cleared` takes
 * it back. prepareQcEmailPreview uses it for that order's next proof email, so
 * every way a QC pass sends (the QC screen, the day screen, /approve and the
 * agent's commit) sends these words. It is spent by the first proof email made
 * after it that did not fail; a failed send leaves it waiting for the retry.
 *
 * The body is a template like any other: {{first_name}}, {{proof_link}} and
 * {{sign_off}} fill in. It must carry {{proof_link}}: the customer has to be
 * able to open and approve the proof, so a body without it is ignored and the
 * template goes.
 */
import { and, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { activityLog, messages } from "@/lib/db/schema";
import type { EmailTemplate, TemplateKey } from "@/lib/email/template-meta";

export const CUSTOM_PROOF_SET = "proof.custom_email_set";
export const CUSTOM_PROOF_CLEARED = "proof.custom_email_cleared";
export const CUSTOM_PROOF_LABEL = "Custom message for this order";

/** The keys a QC pass sends a proof under (selectProofTemplate). Reminders and stage emails never spend it. */
export const PROOF_EMAIL_KEYS: TemplateKey[] = [
  "proof_ready",
  "revision_received",
  "proof_ready_digital_single",
  "proof_ready_digital_multi",
  "proof_ready_physical_single",
  "proof_ready_physical_multi",
];

export type CustomProofEmail = EmailTemplate & { why: string | null; setAt: Date };

export type CustomProofRow = { action: string; metadata: unknown; createdAt: Date };
export type ProofMessageRow = { createdAt: Date; status: string; templateKey: string | null };

const PROOF_LINK = /\{\{\s*proof_link\s*\}\}/;

export function parseCustomProofEmail(metadata: unknown): (EmailTemplate & { why: string | null }) | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const subject = typeof m.subject === "string" ? m.subject.trim() : "";
  const body = typeof m.body === "string" ? m.body.trim() : "";
  if (!subject || subject.length > 300 || /[\r\n]/.test(subject)) return null;
  if (!body || body.length > 20000 || !PROOF_LINK.test(body)) return null;
  const why = typeof m.why === "string" && m.why.trim() ? m.why.trim().slice(0, 300) : null;
  return { subject, body, why };
}

/** Pure: the newest set/clear row decides; a set is spent by a proof email made after it that did not fail. */
export function pickCustomProofEmail(rows: CustomProofRow[], proofMessages: ProofMessageRow[]): CustomProofEmail | null {
  const newest = rows
    .filter((r) => r.action === CUSTOM_PROOF_SET || r.action === CUSTOM_PROOF_CLEARED)
    .reduce<CustomProofRow | null>((a, r) => (!a || r.createdAt.getTime() > a.createdAt.getTime() ? r : a), null);
  if (!newest || newest.action !== CUSTOM_PROOF_SET) return null;
  const parsed = parseCustomProofEmail(newest.metadata);
  if (!parsed) return null;
  const spent = proofMessages.some(
    (m) =>
      m.status !== "failed" &&
      m.templateKey != null &&
      (PROOF_EMAIL_KEYS as string[]).includes(m.templateKey) &&
      m.createdAt.getTime() > newest.createdAt.getTime(),
  );
  return spent ? null : { ...parsed, setAt: newest.createdAt };
}

/** The custom proof email still waiting for this order's next QC pass, or null for the template. */
export async function pendingCustomProofEmail(tx: Tx, orderId: string): Promise<CustomProofEmail | null> {
  const rows = await tx
    .select({ action: activityLog.action, metadata: activityLog.metadata, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(and(eq(activityLog.orderId, orderId), inArray(activityLog.action, [CUSTOM_PROOF_SET, CUSTOM_PROOF_CLEARED])))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  const newest = rows[0];
  if (!newest || newest.action !== CUSTOM_PROOF_SET) return null;
  const sent = await tx
    .select({ createdAt: messages.createdAt, status: messages.status, templateKey: messages.templateKey })
    .from(messages)
    .where(
      and(
        eq(messages.orderId, orderId),
        eq(messages.direction, "outbound"),
        isNotNull(messages.proofId),
        inArray(messages.templateKey, PROOF_EMAIL_KEYS),
        gt(messages.createdAt, newest.createdAt),
      ),
    );
  return pickCustomProofEmail(rows, sent);
}
