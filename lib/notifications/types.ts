export const ALERT_TYPES = {
  orderDueSoon: "order.due_soon",
  orderOverdue: "order.overdue",
  orderOverdueEscalated: "order.overdue_escalated",
  orderIntakeStale: "order.intake_stale",
  proofNoResponse: "proof.no_response",
  shopSyncStale: "shop.sync_stale",
  mailUnmatchedReplyStale: "mail.unmatched_reply_stale",
  notificationPresenceGap: "notification.presence_gap",
} as const;

export type AlertType = (typeof ALERT_TYPES)[keyof typeof ALERT_TYPES];

export const REQUIRED_ALERT_TYPES = [
  ALERT_TYPES.orderOverdue,
  ALERT_TYPES.orderOverdueEscalated,
] as const;

export type NotificationVM = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: string;
};

export function fallbackNotificationTitle(type: string): string {
  switch (type) {
    case "message.received":
      return "Customer reply received";
    case "message.reply_suggestion":
      return "Reply needs review";
    case "gmail.reauth_required":
      return "Gmail needs reconnecting";
    case "etsy.reauth_required":
      return "Etsy needs reconnecting";
    case ALERT_TYPES.orderDueSoon:
      return "Order due soon";
    case ALERT_TYPES.orderOverdue:
      return "Order overdue";
    case ALERT_TYPES.orderOverdueEscalated:
      return "Overdue escalation";
    case ALERT_TYPES.orderIntakeStale:
      return "Intake has been waiting";
    case ALERT_TYPES.proofNoResponse:
      return "Proof has no response";
    case ALERT_TYPES.shopSyncStale:
      return "Shop sync is stale";
    case ALERT_TYPES.mailUnmatchedReplyStale:
      return "Unmatched customer reply";
    case ALERT_TYPES.notificationPresenceGap:
      return "Notification presence gap";
    default:
      return "Notification";
  }
}
