import { formatAt } from "@/lib/time";
import { joinNames } from "@/lib/photos/subject-types";

/**
 * Plain-English name for an activity_log action key, for the order page and
 * customer page feeds. Status moves (`order.<status>`) read as the status;
 * known event keys get a short phrase; anything else is sentence-cased
 * ("print.manual_started" -> "Print manual started"), never a raw key.
 */
const LABELS: Record<string, string> = {
  comment: "Note",
  "order.assigned": "Assigned",
  "agent.assigned": "Assigned by the agent",
  "agent.invoice_made": "Agent invoiced an add-on on this order",
  "agent.invoice_addon_linked": "Paid add-on linked to its order",
  "agent.product_unregistered": "Agent removed a product it added by mistake",
  "agent.rebalanced": "Agent moved it to another designer",
  "agent.not_started_moved": "Agent moved it: not started in time",
  "agent.photo_shortfall_drafted": "Agent drafted a photo request",
  "agent.exception_opened": "Agent raised an exception",
  "agent.etsy_details_completed": "Agent completed the order details",
  "agent.reply_applied": "Agent applied the buyer reply",
  "agent.reply_escalated": "Agent asked a human about a reply",
  "agent.reply_answer_drafted": "Agent drafted an answer",
  "agent.proof_reminder_drafted": "Agent drafted a proof reminder",
  "email.proof_reminder_withdrawn": "Proof reminder withdrawn: the buyer answered",
  "order.reassigned": "Reassigned",
  "order.imported": "Imported",
  "order.created_manual": "Created by hand",
  "order.details_updated": "Details updated",
  "order.tracking_added": "Tracking added",
  "order.same_buyer_noted": "Buyer's other orders noted",
  "order.style_fallback": "Second style drawn by the main portrait's designer",
  "order.marked_urgent": "Marked urgent",
  "order.cleared_urgent": "No longer urgent",
  "order.reopened_by_buyer": "Reopened: the buyer wrote",
  "order.shipping_address_saved": "Shipping address saved",
  "order.reresolved": "Details re-checked",
  "order.reconciled": "Reconciled with the shop",
  "order.reclassified": "Order type changed",
  "order.awaiting_qc": "Awaiting QC",
  "qc.overdue_urgent": "QC overdue: owner alerted",
  "qc.backup_approver": "QC passed to the backup approver",
  "order.wrong_file_override": "Wrong-file stop overridden",
  "order.wrong_file_heads_up": "Handed in a picture that is also on another order",
  "order.revision_stop_override": "Sent although Auto QC said the revision was not done",
  "order.duplicate_slots_override": "Sent although two portraits were the same file",
  "order.photo_subjects_checked": "Photos checked: who is in each",
  "order.photo_subject_cleared": "Photo marked fine",
  "order.photo_subjects_override": "Given to a designer without a clear face photo",
  "order.photo_subject_filled": "New photo of a pet or person added",
  "agent.photo_check_missed": "Given to a designer before the photo check ran",
  "agent.photo_hold_parked": "Waiting on a photo before it goes to a designer",
  "order.awaiting_approval": "Awaiting approval",
  "order.fulfillment_only": "Fulfilment only",
  "proof.viewed": "Proof viewed",
  "proof.held_for_siblings": "Proof held to go with her other order",
  "proof.hold_released": "Held proof let go",
  "proof.sibling_waiting": "Her other portrait waits for this one",
  "proof.sibling_released": "Her other portrait went out",
  "email.sent": "Email sent",
  "email.send_failed": "Email failed",
  "email.composed": "Email written",
  "email.discarded": "Email discarded",
  "email.marked_sent_manually": "Email marked sent",
  "asset.uploaded": "File uploaded",
  "message.received": "Message received",
  "message.handled": "Marked as answered",
  "message.reply_classified": "Reply read",
  "message.reply_classification_decided": "Reply decided",
  "print.manual_started": "Print started by hand",
  "print.reconcile_tracking_added": "Tracking found",
  "print.reconcile_part_shipped": "Part of the print shipped, buyer emailed",
  "print.reconcile_store_tracking": "Tracking sent to the shop",
  "print.reconcile_missing": "Print job missing",
  "style.learned": "Style learned",
  "style.set_once": "Style set",
};

export function activityLabel(action: string): string {
  const known = LABELS[action];
  if (known) return known;
  const words = action.replace(/^order\./, "").replace(/[._]+/g, " ").trim();
  if (!words) return "Updated";
  return words.charAt(0).toUpperCase() + words.slice(1).replace(/\bqc\b/gi, "QC");
}

/**
 * One plain line of extra detail for an activity row whose label alone would
 * mislead, or null. A buyer's reply that came in on another of their orders'
 * threads but names this order reads "Message received" with no hint of that,
 * so it says which thread it came in on (lib/agent/buyer-orders.ts writes it).
 */
export function activityDetail(action: string, metadata: Record<string, unknown> | null | undefined): string | null {
  if (action === "proof.held_for_siblings" || action === "proof.hold_released") return holdDetail(action, metadata);
  if (action === "proof.sibling_waiting") {
    const n = typeof metadata?.heldOrderNumber === "string" ? metadata.heldOrderNumber.trim() : "";
    return `${n ? (n.startsWith("#") ? n : `#${n}`) : "Her other order"} passed QC and goes to her together with this one.`;
  }
  if (action === "order.style_fallback") return typeof metadata?.note === "string" ? metadata.note : null;
  const photo = photoSlotDetail(action, metadata);
  if (photo !== undefined) return photo;
  if (action !== "message.received" || !metadata || metadata.linkedBy !== "mention") return null;
  const from = typeof metadata.fromOrderNumber === "string" ? metadata.fromOrderNumber.trim() : "";
  return from
    ? `A reply on ${from} names this order. Check which order they mean.`
    : "A reply on another order of this buyer names this order. Check which order they mean.";
}

const RELEASE_WORDS: Record<string, string> = {
  she_asked: "She wrote in, so it went at once.",
  group_ready: "Her other order is ready, so they went together.",
  due: "Sent before its due time.",
  send_now: "Sent now by hand.",
  sent_elsewhere: "It had already been sent from the outbox.",
  discarded: "The held email was discarded, so nothing went.",
  order_moved: "The order moved on, so the held email did not go.",
  superseded: "A newer proof replaced it, so it did not go.",
};

/** The deliver-together lines (lib/orders/deliver-together.ts): what it waits on, or why it went. */
function holdDetail(action: string, metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  if (action === "proof.hold_released") return RELEASE_WORDS[String(metadata.reason ?? "")] ?? null;
  const waiting = Array.isArray(metadata.waitingOn)
    ? (metadata.waitingOn as { number?: unknown }[]).map((w) => String(w?.number ?? "")).filter(Boolean).map((n) => (n.startsWith("#") ? n : `#${n}`))
    : [];
  const until = typeof metadata.holdUntil === "string" ? metadata.holdUntil : null;
  const when = until
    ? formatAt(until, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }, "its due time")
    : "its due time";
  return `Waits for ${waiting.length ? waiting.join(", ") : "her other order"}. Sends when that passes QC, or at ${when} at the latest.`;
}

const textList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/** The pet slots (lib/photos/subjects.ts): undefined = not one of its rows. */
function photoSlotDetail(action: string, metadata: Record<string, unknown> | null | undefined): string | null | undefined {
  const reason = typeof metadata?.reason === "string" ? metadata.reason.trim() : "";
  if (action === "order.photo_subjects_checked") {
    if (!Array.isArray(metadata?.subjects) || metadata.subjects.length === 0) return null;
    const holding = textList(metadata.holding);
    return holding.length ? `No clear face photo of ${joinNames(holding)} yet.` : "Every pet and person has a clear face photo.";
  }
  if (action === "order.photo_subject_cleared") {
    const name = typeof metadata?.name === "string" ? metadata.name.trim() : "";
    return name || reason ? [name, reason].filter(Boolean).join(": ") : null;
  }
  if (action === "order.photo_subjects_override") {
    const names = joinNames(textList(metadata?.subjects));
    return names || reason ? [names, reason].filter(Boolean).join(": ") : null;
  }
  if (action === "order.photo_subject_filled") {
    const name = typeof metadata?.name === "string" ? metadata.name.trim() : "";
    const n = typeof metadata?.photoNumber === "number" ? metadata.photoNumber : null;
    return name ? `New photo of ${name} added${n ? `, photo ${n}` : ""}` : null;
  }
  if (action === "agent.photo_hold_parked") {
    const names = joinNames(textList(metadata?.subjects));
    return names ? `Waiting on a photo of ${names}` : null;
  }
  if (action === "agent.photo_check_missed") return "The photo check had not run on her photos after two hours, so it went on.";
  if (action === "agent.photo_shortfall_drafted" && metadata?.via === "photo_subjects") {
    const names = joinNames(textList(metadata.subjects));
    return names ? `Asked her once for a clear face photo of ${names}.` : null;
  }
  return undefined;
}
