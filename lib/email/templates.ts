import { and, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { businesses, emailTemplates } from "@/lib/db/schema";

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
  // exception; proof_reminder is always a draft (the 7-day silence rule acts on
  // the proof directly rather than needing a reply).
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
    description: "Drafted the moment an order is placed — a warm acknowledgement, not a status update.",
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
  proof_ready_digital_single: {
    subject: "Your {{business_name}} portrait proof is ready",
    body: `Hi {{first_name}}!

Your digital portrait from {{business_name}} is now ready for you. Attached to this email is the high-resolution image.

If there's anything you'd like us to refine or adjust, please let us know.

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with feedback.

Warm regards,
The {{business_name}} team`,
  },
  proof_ready_digital_multi: {
    subject: "Your {{business_name}} portrait proofs are ready",
    body: `Hi {{first_name}}!

Your digital portraits from {{business_name}} are now ready for you. Attached to this email is the high-resolution image.

If there's anything you'd like us to refine or adjust, please let us know.

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with feedback.

Warm regards,
The {{business_name}} team`,
  },
  proof_ready_physical_single: {
    subject: "Your {{business_name}} portrait proof is ready",
    body: `Hi {{first_name}}!

Your portrait proof from {{business_name}} is now ready for you. Attached to this email is the high-resolution image.

If there's anything you'd like us to refine or adjust, please let us know.

Once you confirm, we will send it to be printed and shipped.

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with feedback.

Warm regards,
The {{business_name}} team`,
  },
  proof_ready_physical_multi: {
    subject: "Your {{business_name}} portrait proofs are ready",
    body: `Hi {{first_name}}!

Your portrait proofs from {{business_name}} are now ready for you. Attached to this email is the high-resolution image.

If there's anything you'd like us to refine or adjust, please let us know.

Once you confirm, we will send them to be printed and shipped.

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with feedback.

Warm regards,
The {{business_name}} team`,
  },
  revision_received: {
    subject: "Your revised {{business_name}} portrait is ready",
    body: `Hi {{first_name}},

Thank you for your patience. Here's the revised portrait. Please let me know what you think of this updated version. :)

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with feedback.

Have a great day ahead!

Warm regards,
The {{business_name}} team`,
  },
  order_received: {
    subject: "We've got your order, {{first_name}}!",
    body: `Hi {{first_name}},

Thank you for your order ({{order_number}}) with {{business_name}}! We're excited to get started.

We'll keep you posted as your portrait moves along, and you'll get a link to review the finished piece before anything is finalized.

Reply to this email any time if you have a question.

Warmly,
The {{business_name}} team`,
  },
  in_design: {
    subject: "Your {{business_name}} portrait is now with the artist",
    body: `Hi {{first_name}},

Good news — order {{order_number}} is now in the hands of one of our artists! We'll send you a proof to review as soon as it's ready.

Warmly,
The {{business_name}} team`,
  },
  printing: {
    subject: "Your {{business_name}} portrait is being printed",
    body: `Hi {{first_name}},

You approved your portrait for order {{order_number}} — thank you! It's now on its way to our print team, and we'll email you tracking details the moment it ships.

Warmly,
The {{business_name}} team`,
  },
  shipped: {
    subject: "Your {{business_name}} order has shipped!",
    body: `Hi {{first_name}},

Your order {{order_number}} has shipped!

Tracking number: {{tracking_number}}
Track your package: {{tracking_url}}

Thanks so much for choosing {{business_name}} — we hope you love it.

Warmly,
The {{business_name}} team`,
  },
  photo_reminder: {
    subject: "Still waiting on your photos for order {{order_number}}",
    body: `Hi {{first_name}},

We're ready to start on your {{business_name}} portrait but still need your photos for order {{order_number}}.

Please upload them here — it only takes a minute:
{{upload_link}}

Reply to this email if you have any questions.

Warmly,
The {{business_name}} team`,
  },
  proof_reminder: {
    subject: "Your {{business_name}} proof is waiting for you",
    body: `Hi {{first_name}},

Just a friendly reminder that your portrait proof for order {{order_number}} is ready and waiting for your review:

{{proof_link}}

If we don't hear from you after a little while, we'll go ahead and finalize it as-is so your order isn't delayed — but we'd love your feedback first!

Warmly,
The {{business_name}} team`,
  },
};

export const PIXART_TEMPLATES: Partial<Record<TemplateKey, EmailTemplate>> = {
  proof_ready_digital_single: {
    subject: "Your PixArt portrait proof is ready",
    body: `Hi {{first_name}}!

Your digital portrait from PixArt Creatives is now ready for you. Attached to this email is the high-resolution image of your beloved pet.

We've captured the unique personality and essence of your pet in this stunning portrait. If there's anything you'd like us to refine or adjust, please let us know. Our team is dedicated to ensuring your pet's portrait exceeds your expectations.

Limited time only! Want to get your portrait printed at a discount? Use this link here:
https://pixartcreatives.co/products/print-ship

Thank you for choosing PixArt Creatives to create a timeless representation of your furry friend. We hope this portrait brings you joy and becomes a cherished memory.

Feel free to reply to this email if you have any questions or need further assistance.

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

Warm regards,
The PixArt Creatives Team`,
  },
  proof_ready_digital_multi: {
    subject: "Your PixArt portrait proofs are ready",
    body: `Hi {{first_name}}!

Your digital portraits from PixArt Creatives are now ready for you. Attached to this email is the high-resolution image of your beloved pets.

We've captured the unique personality and essence of your pets in these stunning portraits. If there's anything you'd like us to refine or adjust, please let us know. Our team is dedicated to ensuring your pet portraits exceeds your expectations.

Limited time only! Want to get your portrait printed at a discount? Use this link here:
https://pixartcreatives.co/products/print-ship

Thank you for choosing PixArt Creatives to create a timeless representation of your furry friends. We hope this portrait brings you joy and becomes a cherished memory.

Feel free to reply to this email if you have any questions or need further assistance.

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

Warm regards,
The PixArt Creatives Team`,
  },
  proof_ready_physical_single: {
    subject: "Your PixArt portrait proof is ready",
    body: `Hi {{first_name}}!

Your digital portrait from PixArt Creatives is now ready for you. Attached to this email is the high-resolution image of your beloved pet.

We've captured the unique personality and essence of your pet in this stunning portrait. If there's anything you'd like us to refine or adjust, please let us know. Our team is dedicated to ensuring your pet's portrait exceeds your expectations.

Once you confirm, we will have it sent to our printing department to be printed and shipped off to you.

Thank you for choosing PixArt Creatives to create a timeless representation of your furry friend. We hope this portrait brings you joy and becomes a cherished memory.

Feel free to reply to this email if you have any questions or need further assistance.

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

Warm regards,
The PixArt Creatives Team`,
  },
  proof_ready_physical_multi: {
    subject: "Your PixArt portrait proofs are ready",
    body: `Hi {{first_name}}!

Your digital portraits from PixArt Creatives are now ready for you. Attached to this email is the high-resolution images of your beloved pets.

We've captured the unique personality and essence of your pets in this stunning portrait. If there's anything you'd like us to refine or adjust, please let us know. Our team is dedicated to ensuring your pet's portrait exceeds your expectations.

Once you confirm, we will have it sent to our printing department to be printed and shipped off to you.

Thank you for choosing PixArt Creatives to create a timeless representation of your furry friends. We hope this portrait brings you joy and becomes a cherished memory.

Feel free to reply to this email if you have any questions or need further assistance.

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

Warm regards,
The PixArt Creatives Team`,
  },
  revision_received: {
    subject: "Your revised PixArt portrait is ready",
    body: `Hi {{first_name}}!

Thank you for your patience. Here's the revised portrait. Please let me know what you think of this updated version. :)

You can approve or request changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

Have a great day ahead!

Warm regards,
The PixArt Creatives Team`,
  },
};

function isPixArtBusiness(business: BusinessTemplateIdentity): boolean {
  return business.slug === "pixart" || /\bpixart\b/i.test(business.name ?? "");
}

export function defaultTemplateForBusiness(
  business: BusinessTemplateIdentity,
  key: TemplateKey,
): EmailTemplate {
  if (isPixArtBusiness(business)) return PIXART_TEMPLATES[key] ?? DEFAULT_TEMPLATES[key];
  return DEFAULT_TEMPLATES[key];
}

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
  if (row) return row;
  const [business] = await tx
    .select({ name: businesses.name, slug: businesses.slug })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return defaultTemplateForBusiness(business ?? {}, key);
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
