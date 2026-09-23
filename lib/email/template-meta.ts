// Template keys, labels and variables: plain data with no database imports,
// so client components can import it without pulling the database driver
// into the browser bundle (docs/PERF.md). lib/email/templates.ts re-exports it.

export type TemplateKey =
  | "photo_request"
  | "proof_ready"
  | "revision_received"
  | "proof_ready_digital_single"
  | "proof_ready_digital_multi"
  | "proof_ready_physical_single"
  | "proof_ready_physical_multi"
  // Stage emails (the customer window). Drafted on transitions; auto-sent only
  // when the business opted in (businesses.stage_email_auto_send).
  | "order_received"
  | "in_design"
  | "printing"
  | "shipped"
  // Reminders sweep (lib/reminders). photo_reminder is the second auto-send
  // exception (always queued); proof_reminder follows stage_email_auto_send
  // like the other stage emails (draft unless the business opted in).
  | "photo_reminder"
  | "proof_reminder";

/** The variables a template body/subject may reference, as `{{snake_case}}`. */
export type TemplateVars = {
  first_name: string;
  order_number: string;
  business_name: string;
  proof_link?: string;
  upload_link?: string;
  tracking_number?: string;
  tracking_url?: string;
};

export type EmailTemplate = { subject: string; body: string };
export type BusinessTemplateIdentity = { name?: string | null; slug?: string | null };

/** Human labels + the variables each template supports, for the editor UI. */
export const TEMPLATE_META: Record<
  TemplateKey,
  { label: string; description: string; variables: (keyof TemplateVars)[] }
> = {
  photo_request: {
    label: "Photo request",
    description: "Sent automatically on order import. Contains the upload link.",
    variables: ["first_name", "order_number", "business_name", "upload_link"],
  },
  proof_ready: {
    label: "Proof ready (legacy)",
    description: "Legacy proof-ready template kept so existing rows remain readable.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  proof_ready_digital_single: {
    label: "Proof ready · digital · single",
    description: "Auto-selected for first-pass digital orders with one figure.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  proof_ready_digital_multi: {
    label: "Proof ready · digital · multi",
    description: "Auto-selected for first-pass digital orders with multiple figures.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  proof_ready_physical_single: {
    label: "Proof ready · physical · single",
    description: "Auto-selected for first-pass physical orders with one figure.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  proof_ready_physical_multi: {
    label: "Proof ready · physical · multi",
    description: "Auto-selected for first-pass physical orders with multiple figures.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  revision_received: {
    label: "Revision ready",
    description: "Auto-selected when a revised portrait is ready after a revision round.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  order_received: {
    label: "Order received",
    description: "Drafted the moment an order is placed, a warm acknowledgement, not a status update.",
    variables: ["first_name", "order_number", "business_name"],
  },
  in_design: {
    label: "In the artist's hands",
    description: "Drafted when an order is first assigned to a designer.",
    variables: ["first_name", "order_number", "business_name"],
  },
  printing: {
    label: "Now printing",
    description: "Drafted when an approved physical order moves to printing.",
    variables: ["first_name", "order_number", "business_name"],
  },
  shipped: {
    label: "Shipped",
    description: "Drafted when tracking is added and the order moves to shipped.",
    variables: ["first_name", "order_number", "business_name", "tracking_number", "tracking_url"],
  },
  photo_reminder: {
    label: "Photo reminder",
    description: "The 48-hour nudge when photos still haven't arrived. Auto-sent like the initial photo request.",
    variables: ["first_name", "order_number", "business_name", "upload_link"],
  },
  proof_reminder: {
    label: "Proof reminder",
    description: "The 3-day nudge when a sent proof hasn't been reviewed yet.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
};

export const EDITABLE_TEMPLATE_KEYS: TemplateKey[] = [
  "photo_request",
  "proof_ready_digital_single",
  "proof_ready_digital_multi",
  "proof_ready_physical_single",
  "proof_ready_physical_multi",
  "revision_received",
  "order_received",
  "in_design",
  "printing",
  "shipped",
  "photo_reminder",
  "proof_reminder",
];
