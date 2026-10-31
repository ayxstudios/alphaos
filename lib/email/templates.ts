import { and, eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { businesses, emailTemplates } from "@/lib/db/schema";

import { signOffFor, withPhotoWords } from "./template-meta";
import type { BusinessTemplateIdentity, EmailTemplate, TemplateKey, TemplateVars } from "./template-meta";

export { EDITABLE_TEMPLATE_KEYS, TEMPLATE_META, signOffFor, withPhotoWords } from "./template-meta";
export type { BusinessTemplateIdentity, EmailTemplate, TemplateKey, TemplateVars } from "./template-meta";

/**
 * Built-in defaults used when a business has not customised a template. Editing a
 * template writes an email_templates row that overrides the matching default.
 *
 * Every buyer email is written and signed by the shop's one person, who is also
 * the artist (Yousif 2026-10-28): first person, "I", never "the team", "our
 * artist" or "one of our artists". {{sign_off}} is filled by resolveTemplate from
 * the business (signOffFor). No em dashes (house rule).
 */
export const DEFAULT_TEMPLATES: Record<TemplateKey, EmailTemplate> = {
  photo_request: {
    subject: "Ready to start your {{business_name}} portrait: please send your photos",
    body: `Hi {{first_name}},

Thank you so much for your order ({{order_number}})! To get started on your portrait, I just need your photos.

You can upload them here:
{{upload_link}}

Or just reply to this email with them attached. If you have any questions, I'm happy to help.

{{sign_off}}`,
  },
  proof_ready: {
    subject: "Your {{business_name}} portrait is ready",
    body: `Hi {{first_name}},

Your portrait for order {{order_number}} is ready! Take a look and let me know what you think:

{{proof_link}}

If you love it, you can approve it right there. If you'd like any changes, just tell me what to tweak.

{{sign_off}}`,
  },
  proof_ready_digital_single: {
    subject: "Your {{business_name}} portrait is ready",
    body: `Hi {{first_name}}!

Your portrait is ready! I've attached the high-resolution image to this email.

You can approve it or ask for changes here: {{proof_link}}. You can also just reply to this email with anything you'd like changed.

{{sign_off}}`,
  },
  proof_ready_digital_multi: {
    subject: "Your {{business_name}} portraits are ready",
    body: `Hi {{first_name}}!

Your portraits are ready! I've attached the high-resolution images to this email.

You can approve them or ask for changes here: {{proof_link}}. You can also just reply to this email with anything you'd like changed.

{{sign_off}}`,
  },
  proof_ready_physical_single: {
    subject: "Your {{business_name}} portrait is ready",
    body: `Hi {{first_name}}!

Your portrait is ready for you to look over! I've attached the high-resolution image to this email.

You can approve it or ask for changes here: {{proof_link}}. You can also just reply to this email with anything you'd like changed. Once you approve it, I'll send it off to be printed and shipped to you.

{{sign_off}}`,
  },
  proof_ready_physical_multi: {
    subject: "Your {{business_name}} portraits are ready",
    body: `Hi {{first_name}}!

Your portraits are ready for you to look over! I've attached the high-resolution images to this email.

You can approve them or ask for changes here: {{proof_link}}. You can also just reply to this email with anything you'd like changed. Once you approve them, I'll send them off to be printed and shipped to you.

{{sign_off}}`,
  },
  revision_received: {
    subject: "Your updated {{business_name}} portrait is ready",
    body: `Hi {{first_name}},

Here's your updated portrait! Let me know what you think. :)

You can approve it or ask for changes here: {{proof_link}}. You can also just reply to this email with anything you'd like changed.

{{sign_off}}`,
  },
  order_received: {
    subject: "Thanks for your order, {{first_name}}!",
    body: `Hi {{first_name}},

Thank you so much for your order ({{order_number}})! I can't wait to get started on your portrait.

I'll send you a link to look over your portrait before anything is final. If you have a question in the meantime, just reply to this email.

{{sign_off}}`,
  },
  in_design: {
    subject: "I've started on your {{business_name}} portrait",
    body: `Hi {{first_name}},

Good news, I've started on your portrait for order {{order_number}}! I'll send it to you to look over as soon as it's ready.

{{sign_off}}`,
  },
  printing: {
    subject: "Your {{business_name}} portrait is being printed",
    body: `Hi {{first_name}},

Thank you for approving your portrait for order {{order_number}}! It's being printed now, and I'll email you the tracking details as soon as it ships.

{{sign_off}}`,
  },
  shipped: {
    subject: "Your {{business_name}} order has shipped!",
    body: `Hi {{first_name}},

Your order {{order_number}} has shipped!

Tracking number: {{tracking_number}}
Track your package: {{tracking_url}}

Thanks so much for supporting my shop, I hope you love it!

{{sign_off}}`,
  },
  photo_reminder: {
    subject: "Still waiting on your photos for order {{order_number}}",
    body: `Hi {{first_name}},

Just a quick reminder that I'm ready to start your {{business_name}} portrait for order {{order_number}}, I just need your photos.

You can upload them here, it only takes a minute:
{{upload_link}}

Already sent them another way? Just reply to this email and let me know.

{{sign_off}}`,
  },
  photo_shortfall: {
    subject: "A quick question about your {{business_name}} portrait (order {{order_number}})",
    body: `Hi {{first_name}},

Thanks so much for your {{photos_have_noun}}! Your order is for a portrait of {{photos_need_words}}, so if you have a clear photo of each of them, you can add them here:
{{upload_link}}

If what you've sent already shows {{photos_need_all}} clearly, just reply and let me know and I'll get started.

{{sign_off}}`,
  },
  proof_reminder: {
    subject: "Your {{business_name}} portrait is waiting for you",
    body: `Hi {{first_name}},

Just a friendly reminder that your portrait for order {{order_number}} is ready for you to look over:

{{proof_link}}

Once you approve it, I'll send it off to be printed and shipped. If you'd like anything changed, just reply and let me know!

{{sign_off}}`,
  },
};

const PIXART_PRINT_LINE = `Limited time only! Want to get your portrait printed at a discount? Use this link here:
https://pixartcreatives.co/products/print-ship`;

export const PIXART_TEMPLATES: Partial<Record<TemplateKey, EmailTemplate>> = {
  proof_ready_digital_single: {
    subject: "Your PixArt portrait is ready",
    body: `Hi {{first_name}}!

Your digital portrait from PixArt Creatives is ready! I've attached the high-resolution image of your beloved pet to this email.

I hope I've captured your pet's personality just right. If there's anything you'd like me to refine or adjust, just let me know.

${PIXART_PRINT_LINE}

Thank you for choosing PixArt Creatives. I hope this portrait brings you joy and becomes a cherished memory.

You can approve it or ask for changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

{{sign_off}}`,
  },
  proof_ready_digital_multi: {
    subject: "Your PixArt portraits are ready",
    body: `Hi {{first_name}}!

Your digital portraits from PixArt Creatives are ready! I've attached the high-resolution images of your beloved pets to this email.

I hope I've captured your pets' personalities just right. If there's anything you'd like me to refine or adjust, just let me know.

${PIXART_PRINT_LINE}

Thank you for choosing PixArt Creatives. I hope these portraits bring you joy and become a cherished memory.

You can approve them or ask for changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

{{sign_off}}`,
  },
  proof_ready_physical_single: {
    subject: "Your PixArt portrait is ready",
    body: `Hi {{first_name}}!

Your portrait from PixArt Creatives is ready! I've attached the high-resolution image of your beloved pet to this email.

I hope I've captured your pet's personality just right. If there's anything you'd like me to refine or adjust, just let me know.

Once you approve it, I'll send it off to be printed and shipped to you.

Thank you for choosing PixArt Creatives. I hope this portrait brings you joy and becomes a cherished memory.

You can approve it or ask for changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

{{sign_off}}`,
  },
  proof_ready_physical_multi: {
    subject: "Your PixArt portraits are ready",
    body: `Hi {{first_name}}!

Your portraits from PixArt Creatives are ready! I've attached the high-resolution images of your beloved pets to this email.

I hope I've captured your pets' personalities just right. If there's anything you'd like me to refine or adjust, just let me know.

Once you approve them, I'll send them off to be printed and shipped to you.

Thank you for choosing PixArt Creatives. I hope these portraits bring you joy and become a cherished memory.

You can approve them or ask for changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

{{sign_off}}`,
  },
  revision_received: {
    subject: "Your updated PixArt portrait is ready",
    body: `Hi {{first_name}}!

Here's your updated portrait! Let me know what you think. :)

You can approve it or ask for changes here: {{proof_link}}. You can also simply reply to this email with any feedback.

{{sign_off}}`,
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
  const [business] = await tx
    .select({ name: businesses.name, slug: businesses.slug, agentConfig: businesses.agentConfig })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const template = row ?? defaultTemplateForBusiness(business ?? {}, key);
  return withSignOff(template, signOffFor({ ...(business ?? {}), replySignOff: replySignOffOf(business?.agentConfig) }));
}

/** agent_config.replySignOff, read the way lib/agent/config.ts reads it (no import: that module pulls in print routing). */
function replySignOffOf(agentConfig: unknown): string | null {
  const v = agentConfig && typeof agentConfig === "object" ? (agentConfig as { replySignOff?: unknown }).replySignOff : null;
  return typeof v === "string" && v.trim() && v.length <= 200 ? v : null;
}

/** Put the shop person's closing lines where a template says {{sign_off}}. */
export function withSignOff(template: EmailTemplate, signOff: string): EmailTemplate {
  const fill = (input: string) => input.replace(/\{\{\s*sign_off\s*\}\}/g, () => signOff);
  return { subject: fill(template.subject), body: fill(template.body) };
}

/** Substitute `{{variable}}` placeholders. Unknown/omitted variables render empty. */
export function renderTemplate(
  template: EmailTemplate,
  rawVars: TemplateVars,
): EmailTemplate {
  // A template that reached here without resolveTemplate (a fallback default)
  // still closes with the shop's person, never a blank line or "the team".
  const vars = withPhotoWords({ sign_off: signOffFor({ name: rawVars.business_name }), ...rawVars });
  return {
    subject: substitute(template.subject, vars),
    body: substitute(template.body, vars),
  };
}

function substitute(input: string, vars: TemplateVars): string {
  // A business called "The Custom Portrait Shop" read "Your The Custom
  // Portrait Shop portrait" and "The The Custom Portrait Shop team" in every
  // default template (customer + security QA 2026-09-25). After "your" or
  // "the", the name drops its own leading "The". Stored templates get the
  // same treatment, so no admin has to reword anything.
  const name = (vars as Record<string, string | undefined>).business_name;
  const bare = name?.replace(/^the\s+/i, "");
  if (name && bare && bare !== name) {
    // "your", "the", or either with one word between ("your revised").
    input = input.replace(
      /\b(your|the)((?: [a-z]+)?) \{\{\s*business_name\s*\}\}/gi,
      (_, word: string, between: string) => `${word}${between} ${bare}`,
    );
  }
  return input.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    return value ?? "";
  });
}
