import { eq } from "drizzle-orm";

import { withSystemContext, SYSTEM_ACTOR_ID, type Tx } from "@/lib/db";
import { proofs } from "@/lib/db/schema";
import {
  runTransition,
  OrderTransitionError,
  type OrderStatus,
} from "@/lib/orders/transitions";
import { issueLabels, sanitizeIssueKeys } from "./issues";
import type { ProofAnnotation } from "@/lib/db/schema";

export type ProofDecision = "approved" | "revision";

export type ProofActionResult =
  | { ok: true; decision: ProofDecision }
  | { ok: false; code: ProofErrorCode; message: string };

export type ProofErrorCode =
  | "not_found"
  | "already_decided"
  | "not_actionable"
  | "invalid";

/** The synthetic system actor used for customer-driven, no-user transitions. */
const SYSTEM_ACTOR = { id: SYSTEM_ACTOR_ID, role: "system" as const };

const MAX_NOTE = 2000;
const MAX_PINS = 20;

export type RevisionInput = {
  issueKeys: unknown;
  note: unknown;
  annotations: unknown;
};

/**
 * Customer approves the proof. Runs entirely in one system transaction:
 *   1. lock the proof row (FOR UPDATE),
 *   2. refuse if a decision was already recorded (the read-only guarantee),
 *   3. run the awaiting_approval -> approved transition (the ONLY status path —
 *      never a direct status write), and
 *   4. stamp the decision on the proof.
 * If the transition fails (e.g. the order was moved), the whole tx rolls back,
 * so the proof is never left half-decided.
 */
export async function approveProof(token: string): Promise<ProofActionResult> {
  return decide(token, "approved", async (tx, orderId, from) => {
    await runTransition(tx, SYSTEM_ACTOR, {
      orderId,
      to: "approved",
      expectedFrom: from,
      metadata: { via: "proof_portal" },
    });
    return {};
  });
}

/**
 * Customer requests a revision. Sends the order back to in_design (a revision
 * edge — increments revisionCount) via the transition function, keeping the same
 * active assignment so the SAME designer picks it up. The structured issues +
 * free-text note + annotation pins are persisted on the proof and carried in the
 * transition metadata so they reach the designer's card.
 */
export async function requestRevision(
  token: string,
  input: RevisionInput,
): Promise<ProofActionResult> {
  const issueKeys = sanitizeIssueKeys(input.issueKeys);
  const note =
    typeof input.note === "string" ? input.note.trim().slice(0, MAX_NOTE) : "";
  const annotations = sanitizeAnnotations(input.annotations);

  // Require SOME signal about what to fix — a checkbox or a note.
  if (issueKeys.length === 0 && !note) {
    return {
      ok: false,
      code: "invalid",
      message: "Tell us what to change — pick an issue or add a note.",
    };
  }

  const reason = buildRevisionNote(issueKeys, note);

  return decide(token, "revision", async (tx, orderId, from) => {
    await runTransition(tx, SYSTEM_ACTOR, {
      orderId,
      to: "in_design",
      expectedFrom: from,
      // NB: runTransition strips `reason`/`failedItems` from client metadata (a
      // QC-only safeguard), so log the customer's detail under distinct keys
      // that survive into the activity_log entry.
      metadata: {
        via: "proof_portal",
        revisionReason: reason,
        revisionIssues: issueLabels(issueKeys),
        annotationCount: annotations.length,
      },
    });
    return { failedItems: issueKeys, annotations, revisionNotes: reason };
  });
}

/** The revision text a designer reads: labelled issues followed by the note. */
function buildRevisionNote(issueKeys: string[], note: string): string {
  const labels = issueLabels(issueKeys);
  const parts: string[] = [];
  if (labels.length) parts.push(labels.join(", "));
  if (note) parts.push(note);
  return parts.join(" — ");
}

function sanitizeAnnotations(raw: unknown): ProofAnnotation[] {
  if (!Array.isArray(raw)) return [];
  const out: ProofAnnotation[] = [];
  for (const a of raw) {
    if (out.length >= MAX_PINS) break;
    const x = (a as { x?: unknown })?.x;
    const y = (a as { y?: unknown })?.y;
    if (typeof x === "number" && typeof y === "number" && isFinite(x) && isFinite(y)) {
      out.push({ x: clamp01(x), y: clamp01(y) });
    }
  }
  return out;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Shared lock-check-transition-stamp flow for both decisions. */
async function decide(
  token: string,
  decision: ProofDecision,
  run: (
    tx: Tx,
    orderId: string,
    from: OrderStatus,
  ) => Promise<{
    failedItems?: string[];
    annotations?: ProofAnnotation[];
    revisionNotes?: string;
  }>,
): Promise<ProofActionResult> {
  try {
    return await withSystemContext(async (tx) => {
      // Lock the proof so two concurrent submissions can't both decide.
      const [proof] = await tx
        .select({
          id: proofs.id,
          orderId: proofs.orderId,
          decision: proofs.decision,
        })
        .from(proofs)
        .where(eq(proofs.token, token))
        .for("update");
      if (!proof) return err("not_found", "This link is no longer valid.");

      // Read-only once decided: cannot approve then flip to revision, or re-submit.
      if (proof.decision) {
        return err(
          "already_decided",
          "A decision has already been recorded for this proof.",
        );
      }

      const extra = await run(tx, proof.orderId, "awaiting_approval");

      await tx
        .update(proofs)
        .set({
          decision,
          decidedAt: new Date(),
          ...(extra.failedItems ? { failedItems: extra.failedItems } : {}),
          ...(extra.annotations ? { annotations: extra.annotations } : {}),
          ...(extra.revisionNotes ? { revisionNotes: extra.revisionNotes } : {}),
        })
        .where(eq(proofs.id, proof.id));

      return { ok: true, decision } as const;
    });
  } catch (e) {
    if (e instanceof OrderTransitionError) {
      // The order isn't where we expected (already approved, on hold, cancelled,
      // moved by a VA…). Surface a friendly, non-leaky message.
      return err(
        "not_actionable",
        "This proof can no longer be actioned. Please contact us if you have questions.",
      );
    }
    throw e;
  }
}

function err(code: ProofErrorCode, message: string): ProofActionResult {
  return { ok: false, code, message };
}
