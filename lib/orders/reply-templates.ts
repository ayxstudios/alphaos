/**
 * The reply-draft template picker, shared by the order page's client
 * component (components/orders/reply-draft.tsx) and the server helpers in
 * lib/orders/reply-draft.ts. This file must stay free of `@/lib/db` (the Neon
 * driver): a "use client" component imports it by value, so everything it
 * pulls in ships to the browser.
 */
// template-meta, not templates: templates.ts also imports the db schema.
import { EDITABLE_TEMPLATE_KEYS, TEMPLATE_META, type TemplateKey } from "@/lib/email/template-meta";

/** A blank starting point, not one of the business's saved templates. */
export const BLANK_TEMPLATE_KEY = "blank" as const;
export type ReplyTemplateChoice = TemplateKey | typeof BLANK_TEMPLATE_KEY;

export type ReplyTemplateOption = { key: ReplyTemplateChoice; label: string };

export const REPLY_TEMPLATE_OPTIONS: ReplyTemplateOption[] = [
  { key: BLANK_TEMPLATE_KEY, label: "Blank message" },
  ...EDITABLE_TEMPLATE_KEYS.map((key) => ({ key, label: TEMPLATE_META[key].label })),
];
