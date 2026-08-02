import { and, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { emailTemplates } from "@/lib/db/schema";

export type TemplateKey = "photo_request" | "proof_ready" | "revision_received";

/** The variables a template body/subject may reference, as `{{snake_case}}`. */
export type TemplateVars = {
  first_name: string;
  order_number: string;
  business_name: string;
  proof_link?: string;
  upload_link?: string;
};

export type EmailTemplate = { subject: string; body: string };

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
    label: "Proof ready",
    description: "Drafted for VA approval when a proof is ready. Contains the proof link.",
    variables: ["first_name", "order_number", "business_name", "proof_link"],
  },
  revision_received: {
    label: "Revision received",
    description: "Acknowledges a customer revision request.",
    variables: ["first_name", "order_number", "business_name"],
  },
};

/**
 * Built-in defaults used when a business has not customised a template. Editing a
 * template writes an email_templates row that overrides the matching default.
 */
export const DEFAULT_TEMPLATES: Record<TemplateKey, EmailTemplate> = {
  photo_request: {
    subject: "We're ready to start your {{business_name}} portrait — send your photos",
    body: `Hi {{first_name}},

Thanks for your order ({{order_number}})! To get started on your custom portrait, we just need your photos.

Please upload them here:
{{upload_link}}

Reply to this email if you have any questions — we're happy to help.

Warmly,
The {{business_name}} team`,
  },
  proof_ready: {
    subject: "Your {{business_name}} portrait proof is ready",
    body: `Hi {{first_name}},

Your portrait for order {{order_number}} is ready to review! Take a look and let us know what you think:

{{proof_link}}

If everything looks perfect, you can approve it right there. If you'd like any changes, just tell us what to tweak.

Warmly,
The {{business_name}} team`,
  },
  revision_received: {
    subject: "We got your revision request — order {{order_number}}",
    body: `Hi {{first_name}},

Thanks for the feedback on your portrait ({{order_number}}). We've passed your notes to the artist and we're on it — you'll get a fresh proof to review as soon as it's ready.

Warmly,
The {{business_name}} team`,
  },
};

/**
 * Resolve the effective template for a business + key: the business's override
 * if one exists, otherwise the built-in default. Must run inside a staff/system
 * tx (email_templates is RLS staff-scoped).
 */
export async function resolveTemplate(
  tx: Tx,
  businessId: string,
  key: TemplateKey,
): Promise<EmailTemplate> {
  const [row] = await tx
    .select({ subject: emailTemplates.subject, body: emailTemplates.body })
    .from(emailTemplates)
    .where(and(eq(emailTemplates.businessId, businessId), eq(emailTemplates.key, key)))
    .limit(1);
  return row ?? DEFAULT_TEMPLATES[key];
}

/** Substitute `{{variable}}` placeholders. Unknown/omitted variables render empty. */
export function renderTemplate(
  template: EmailTemplate,
  vars: TemplateVars,
): EmailTemplate {
  return {
    subject: substitute(template.subject, vars),
    body: substitute(template.body, vars),
  };
}

function substitute(input: string, vars: TemplateVars): string {
  return input.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    return value ?? "";
  });
}
