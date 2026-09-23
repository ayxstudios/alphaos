// Reply-draft choices: plain data, safe for client components (the order
// page's ReplyDraft imports REPLY_TEMPLATE_OPTIONS). The database reads live
// in ./reply-draft-data.ts so the driver never reaches the browser bundle
// (docs/PERF.md).
import { EDITABLE_TEMPLATE_KEYS, TEMPLATE_META, type TemplateKey } from "@/lib/email/template-meta";
import type { OrderStatus } from "./transitions";

/** A blank starting point — not one of the business's saved templates. */
export const BLANK_TEMPLATE_KEY = "blank" as const;
export type ReplyTemplateChoice = TemplateKey | typeof BLANK_TEMPLATE_KEY;

export type ReplyTemplateOption = { key: ReplyTemplateChoice; label: string };

export const REPLY_TEMPLATE_OPTIONS: ReplyTemplateOption[] = [
  { key: BLANK_TEMPLATE_KEY, label: "Blank message" },
  ...EDITABLE_TEMPLATE_KEYS.map((key) => ({ key, label: TEMPLATE_META[key].label })),
];

/** The template most likely to be right for this order's current status. */
export function defaultReplyTemplate(status: OrderStatus): ReplyTemplateChoice {
  switch (status) {
    case "awaiting_photos":
      return "photo_request";
    case "awaiting_approval":
    case "approved":
      return "proof_ready_digital_single";
    case "in_design":
      return "revision_received";
    default:
      return BLANK_TEMPLATE_KEY;
  }
}
