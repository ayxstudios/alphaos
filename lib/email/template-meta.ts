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
    description: "Goes out by itself when a new order arrives without photos. Has the upload link.",
    variables: ["first_name", "order_number", "business_name", "upload_link"],
  },
  proof_ready: {
    label: "Proof ready (older orders)",
    description: "Kept so proof emails sent before the digital and printed versions still read correctly.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  proof_ready_digital_single: {
    label: "Proof ready: digital, one subject",
    description: "The first proof of a digital portrait with one person or pet.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  proof_ready_digital_multi: {
    label: "Proof ready: digital, several subjects",
    description: "The first proof of a digital portrait with more than one person or pet.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  proof_ready_physical_single: {
    label: "Proof ready: printed, one subject",
    description: "The first proof of a printed portrait with one person or pet.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  proof_ready_physical_multi: {
    label: "Proof ready: printed, several subjects",
    description: "The first proof of a printed portrait with more than one person or pet.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  revision_received: {
    label: "Revision ready",
    description: "Sent when the customer asked for changes and the new version is ready.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  order_received: {
    label: "Order received",
    description: "A thank-you the moment an order is placed.",
    variables: ["first_name", "order_number", "business_name"],
  },
  in_design: {
    label: "In the artist's hands",
    description: "Sent when a designer starts on the order.",
    variables: ["first_name", "order_number", "business_name"],
  },
  printing: {
    label: "Now printing",
    description: "Sent when an approved printed portrait goes to print.",
    variables: ["first_name", "order_number", "business_name"],
  },
  shipped: {
    label: "Shipped",
    description: "Sent when a tracking number is added.",
    variables: ["first_name", "order_number", "business_name", "tracking_number", "tracking_url"],
  },
  photo_reminder: {
    label: "Photo reminder",
    description: "Goes out by itself two days after the photo request if no photos arrived.",
    variables: ["first_name", "order_number", "business_name", "upload_link"],
  },
  proof_reminder: {
    label: "Proof reminder",
    description: "Sent three days after a proof if the customer has not answered.",
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

/**
 * The {{placeholders}} in a subject or body that this template cannot fill.
 * A typo ({{frist_name}}) or a link this email never gets ({{tracking_url}}
 * in the photo request) would reach the customer as blank text, so the editor
 * warns and the save refuses, naming the placeholder.
 */
export function unknownPlaceholders(key: TemplateKey, text: string): string[] {
  const allowed = new Set<string>(TEMPLATE_META[key].variables);
  const seen = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const name = m[1].trim();
    if (!allowed.has(name)) seen.add(name || "(empty)");
  }
  return [...seen];
}

/** Sample values for a preview or a test email: what a customer would see. */
export function sampleTemplateVars(businessName: string, appOrigin: string): TemplateVars {
  return {
    first_name: "Sam",
    order_number: "TEST-1001",
    business_name: businessName,
    proof_link: `${appOrigin}/proof/sample-test`,
    upload_link: `${appOrigin}/upload/sample-test`,
    tracking_number: "TEST123456789",
    tracking_url: "https://example.com/track/TEST123456789",
  };
}

/** Substitute {{placeholders}}; a placeholder with no value renders empty. */
export function fillTemplate(template: EmailTemplate, vars: TemplateVars): EmailTemplate {
  const sub = (input: string) =>
    input.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => (vars as Record<string, string | undefined>)[name] ?? "");
  return { subject: sub(template.subject), body: sub(template.body) };
}
