/**
 * Plain-English name for an activity_log action key, for the order page and
 * customer page feeds. Status moves (`order.<status>`) read as the status;
 * known event keys get a short phrase; anything else is sentence-cased
 * ("print.manual_started" -> "Print manual started"), never a raw key.
 */
const LABELS: Record<string, string> = {
  comment: "Note",
  "order.assigned": "Assigned",
  "order.reassigned": "Reassigned",
  "order.imported": "Imported",
  "order.created_manual": "Created by hand",
  "order.details_updated": "Details updated",
  "order.tracking_added": "Tracking added",
  "order.shipping_address_saved": "Shipping address saved",
  "order.reresolved": "Re-resolved",
  "order.reconciled": "Reconciled with the shop",
  "order.reclassified": "Order type changed",
  "order.awaiting_qc": "Awaiting QC",
  "order.awaiting_approval": "Awaiting customer",
  "order.fulfillment_only": "Fulfilment only",
  "proof.viewed": "Proof viewed",
  "email.sent": "Email sent",
  "email.send_failed": "Email failed",
  "email.composed": "Email written",
  "email.discarded": "Email discarded",
  "email.marked_sent_manually": "Email marked sent",
  "asset.uploaded": "File uploaded",
  "message.received": "Message received",
  "message.reply_classified": "Reply read",
  "message.reply_classification_decided": "Reply decided",
  "print.manual_started": "Print started by hand",
  "print.reconcile_tracking_added": "Tracking found",
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
