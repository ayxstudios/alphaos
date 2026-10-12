/**
 * "Changes asked for" on the QC screen: every place a change request can live
 * (a QC send-back, a customer's proof-page revision, a customer email, a
 * revision note, a team comment) merged into one newest-first list.
 *
 * Pure on purpose. The queries live in lib/qc/data.ts and hand their rows to
 * buildChangeRequests, so the merge, the dedupe and the cap are tested without
 * a database (scripts/test-qc-change-requests.ts).
 */
import { failedLabels, splitChecklistLabel } from "@/lib/qc/checklist";
import { issueLabels } from "@/lib/proofs/issues";
import { mailPreview } from "@/lib/email/preview";

export type QcChangeRequestKind =
  | "customer_email"
  | "proof_revision"
  | "qc_send_back"
  | "revision_note"
  | "team_note";

export type QcChangeRequest = {
  kind: QcChangeRequestKind;
  /** When it was asked (ISO). */
  at: string;
  /** "Customer" for the customer, else the team member's name. */
  who: string | null;
  text: string;
  /** Chips: the checklist items that failed, or what the customer ticked. */
  items: string[];
};

/** Most entries the panel lists; the rest are only counted ("N older"). */
export const CHANGE_REQUEST_CAP = 10;
/** A customer email is cut to about this many characters. */
export const EMAIL_TEXT_CHARS = 600;
/** The list hint is one truncated line; no point shipping more than this. */
export const HINT_CHARS = 140;
/** Two rows written this close together are one event (both rows of a QC fail, or of a proof decision). */
const SAME_EVENT_MS = 2 * 60 * 1000;
/** Below this, "one text contains the other" proves nothing ("ok", "thanks"). */
const MIN_OVERLAP_CHARS = 15;

/** The rows each query hands over, reduced to plain values. */
export type ChangeRequestSources = {
  /** qc_checks rows with result "fail". */
  qcFails: {
    at: Date;
    /** The checker's name: the typed signature, else the login's name. */
    who: string | null;
    reason: string | null;
    checklistSnapshot: unknown;
    itemResults: unknown;
  }[];
  /** activity_log rows with action "order.in_design" or "comment". */
  activity: {
    at: Date;
    /** The actor's name; null for the system. */
    who: string | null;
    action: string;
    fromState: string | null;
    metadata: unknown;
  }[];
  /** proofs rows with decision "revision". */
  proofs: {
    at: Date;
    revisionNotes: string | null;
    failedItems: string[] | null;
    annotations: unknown[] | null;
  }[];
  /** The customer's own words: inbound email or Etsy messages. */
  emails: { id: string; at: Date; body: string | null }[];
};

export function emptyChangeRequestSources(): ChangeRequestSources {
  return { qcFails: [], activity: [], proofs: [], emails: [] };
}

/** Where a candidate came from. "log" is the activity-log echo of another source. */
type Source = "qc" | "proof" | "email" | "log" | "comment";

type Candidate = QcChangeRequest & {
  ms: number;
  src: Source;
  /** The inbound message a log row was written for, when it says so. */
  messageId: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** "Likeness: faces, eyes and hair match the photos" -> "Likeness" (the board shows the name only). */
function chip(label: string): string {
  return splitChecklistLabel(label).name;
}

function candidate(
  src: Source,
  kind: QcChangeRequestKind,
  at: Date,
  who: string | null,
  body: string,
  items: string[],
  messageId: string | null = null,
): Candidate | null {
  const ms = at.getTime();
  if (Number.isNaN(ms)) return null;
  // A row with no words and no chips has nothing to show.
  if (!body && items.length === 0) return null;
  return { kind, at: at.toISOString(), who, text: body, items, ms, src, messageId };
}

/**
 * The portal stores the note as "Label, Label. what they wrote" (see
 * buildRevisionNote in lib/proofs/decide.ts). The labels show as chips, so
 * keep only what the customer wrote in the text.
 */
function proofText(notes: string | null, labels: string[]): string {
  const body = text(notes);
  if (!body || labels.length === 0) return body;
  const lead = labels.join(", ");
  if (body === lead) return "";
  if (body.startsWith(`${lead}. `)) return body.slice(lead.length + 2).trim();
  return body;
}

function fromQcFail(row: ChangeRequestSources["qcFails"][number]): Candidate | null {
  return candidate(
    "qc",
    "qc_send_back",
    row.at,
    row.who,
    text(row.reason),
    failedLabels(row.checklistSnapshot, row.itemResults).map(chip),
  );
}

function fromProof(row: ChangeRequestSources["proofs"][number]): Candidate | null {
  const labels = issueLabels(row.failedItems ?? []);
  const marks = row.annotations?.length ?? 0;
  const items = marks > 0 ? [...labels, `${marks} ${marks === 1 ? "mark" : "marks"} on the image`] : labels;
  return candidate("proof", "proof_revision", row.at, "Customer", proofText(row.revisionNotes, labels), items);
}

function fromEmail(row: ChangeRequestSources["emails"][number]): Candidate | null {
  // Only what they typed: quoted history cut, tidied, capped. Nothing left means skip.
  const body = mailPreview(row.body, EMAIL_TEXT_CHARS).preview;
  const made = candidate("email", "customer_email", row.at, "Customer", body, []);
  return made && { ...made, messageId: row.id };
}

function fromActivity(row: ChangeRequestSources["activity"][number]): Candidate | null {
  const meta = record(row.metadata);
  if (row.action === "comment") {
    return candidate("comment", "team_note", row.at, row.who, text(meta.body), []);
  }
  if (row.action !== "order.in_design") return null;

  // A revision note: "Create revision" (va_created_revision), the owner's day
  // bounce, or a proof-page / email decision (which also leave their own row).
  const revisionReason = text(meta.revisionReason);
  if (revisionReason) {
    const messageId = typeof meta.messageId === "string" ? meta.messageId : null;
    return candidate("log", "revision_note", row.at, row.who, revisionReason, [], messageId);
  }

  // A QC send-back (awaiting_qc -> in_design). Its qc_checks row is the fuller
  // record; this one only stands in when that row is missing.
  const fromQc = row.fromState === "awaiting_qc" || text(meta.edge).startsWith("awaiting_qc");
  if (!fromQc) return null;
  const failed = Array.isArray(meta.failedItems)
    ? meta.failedItems.filter((x): x is string => typeof x === "string").map(chip)
    : [];
  return candidate("log", "qc_send_back", row.at, text(meta.signature) || row.who, text(meta.reason), failed);
}

/** Lower-case words only, so "Collar is green!" matches "collar is green". */
function words(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Is this activity-log row only an echo of a richer record of the same request? */
function isEcho(log: Candidate, rich: Candidate): boolean {
  // Written for that very email.
  if (log.messageId && log.messageId === rich.messageId) return true;

  const a = words(log.text);
  const b = words(rich.text);
  if (a && a === b) return true;

  // Same event, two rows: both written by one transition within seconds.
  const together = Math.abs(log.ms - rich.ms) <= SAME_EVENT_MS;
  if (together && log.kind === "qc_send_back" && rich.src === "qc") return true;
  if (together && log.kind === "revision_note" && rich.src === "proof") return true;

  // The decision quotes the email it was made from (whole, or after cleaning).
  if (log.kind === "revision_note" && rich.src === "email" && Math.min(a.length, b.length) >= MIN_OVERLAP_CHARS) {
    return a.includes(b) || b.includes(a);
  }
  return false;
}

/**
 * Merge every source into one list: newest first, each request once, at most
 * `cap` entries, with the rest counted in `older`.
 */
export function buildChangeRequests(
  sources: ChangeRequestSources,
  cap: number = CHANGE_REQUEST_CAP,
): { changeRequests: QcChangeRequest[]; older: number } {
  const all = [
    ...sources.qcFails.map(fromQcFail),
    ...sources.proofs.map(fromProof),
    ...sources.emails.map(fromEmail),
    ...sources.activity.map(fromActivity),
  ].filter((c): c is Candidate => c !== null);

  const rich = all.filter((c) => c.src !== "log");
  const kept = all.filter((c) => c.src !== "log" || !rich.some((r) => isEcho(c, r)));

  // Array.prototype.sort is stable, so equal times keep the order above.
  kept.sort((x, y) => y.ms - x.ms);

  const shown = kept.slice(0, Math.max(0, cap));
  return {
    changeRequests: shown.map(({ kind, at, who, text: body, items }) => ({ kind, at, who, text: body, items })),
    older: kept.length - shown.length,
  };
}

/**
 * The one line under an order on the Awaiting QC list: the newest request,
 * "Customer: ..." when the customer wrote it, else "Asked: ...".
 */
export function changeRequestHint(latest: QcChangeRequest | null | undefined, max: number = HINT_CHARS): string | null {
  if (!latest) return null;
  const said = (latest.text || latest.items.join(", ")).replace(/\s+/g, " ").trim();
  if (!said) return null;
  const who = latest.kind === "customer_email" || latest.kind === "proof_revision" ? "Customer" : "Asked";
  return `${who}: ${said.length > max ? `${said.slice(0, max).trimEnd()}…` : said}`;
}
