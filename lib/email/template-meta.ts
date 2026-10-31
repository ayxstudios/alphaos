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
  | "proof_reminder"
  // Agent autopilot (lib/agent/autopilot.ts): fewer photos than figures
  // ordered. Always a draft; a VA approves it in the outbox.
  | "photo_shortfall"
  // The pet slots (lib/photos/subjects.ts): a pet or person bought with no
  // clear face photo yet, asked for once by name. A draft the outbox sends.
  | "photo_subject_ask";

/** The variables a template body/subject may reference, as `{{snake_case}}`. */
export type TemplateVars = {
  first_name: string;
  order_number: string;
  business_name: string;
  proof_link?: string;
  upload_link?: string;
  tracking_number?: string;
  tracking_url?: string;
  photos_have?: string;
  photos_need?: string;
  /** "photo" or "photos", from photos_have when not given (renderTemplate). */
  photos_have_noun?: string;
  /** "two", "three"... from photos_need when not given (renderTemplate). */
  photos_need_words?: string;
  /** "both of them" / "all three of them", from photos_need when not given (renderTemplate). */
  photos_need_all?: string;
  /** Everyone the portrait is of, as the buyer would say it: "Jax and Rambo" (lib/photos/subject-types.ts subjectAskVars). */
  subject_names?: string;
  /** Who has no clear face photo yet: "a clear photo of Rambo's face" / "clear photos of Jax's and Rambo's faces". */
  subject_missing_faces?: string;
  /** "If you have one, you can add it here:" / "If you have them, you can add them here:". */
  subject_add_line?: string;
  /**
   * The shop person's own closing lines ("Kindest Regards,\nMel"). resolveTemplate
   * fills it from the business (agent_config.replySignOff, else the shop's persona);
   * every buyer email is signed by that one person, never "the team".
   */
  sign_off?: string;
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
    variables: ["first_name", "order_number", "business_name", "upload_link", "sign_off"],
  },
  proof_ready: {
    label: "Proof ready (older orders)",
    description: "Kept so proof emails sent before the digital and printed versions still read correctly.",
    variables: ["first_name", "order_number", "business_name", "proof_link", "sign_off"],
  },
  proof_ready_digital_single: {
    label: "Proof ready: digital, one subject",
    description: "The first proof of a digital portrait with one person or pet.",
    variables: ["first_name", "order_number", "business_name", "proof_link", "sign_off"],
  },
  proof_ready_digital_multi: {
    label: "Proof ready: digital, several subjects",
    description: "The first proof of a digital portrait with more than one person or pet.",
    variables: ["first_name", "order_number", "business_name", "proof_link", "sign_off"],
  },
  proof_ready_physical_single: {
    label: "Proof ready: printed, one subject",
    description: "The first proof of a printed portrait with one person or pet.",
    variables: ["first_name", "order_number", "business_name", "proof_link", "sign_off"],
  },
  proof_ready_physical_multi: {
    label: "Proof ready: printed, several subjects",
    description: "The first proof of a printed portrait with more than one person or pet.",
    variables: ["first_name", "order_number", "business_name", "proof_link", "sign_off"],
  },
  revision_received: {
    label: "Revision ready",
    description: "Sent when the customer asked for changes and the new version is ready.",
    variables: ["first_name", "order_number", "business_name", "proof_link", "sign_off"],
  },
  order_received: {
    label: "Order received",
    description: "A thank-you the moment an order is placed.",
    variables: ["first_name", "order_number", "business_name", "sign_off"],
  },
  in_design: {
    label: "In the artist's hands",
    description: "Sent when a designer starts on the order.",
    variables: ["first_name", "order_number", "business_name", "sign_off"],
  },
  printing: {
    label: "Now printing",
    description: "Sent when an approved printed portrait goes to print.",
    variables: ["first_name", "order_number", "business_name", "sign_off"],
  },
  shipped: {
    label: "Shipped",
    description: "Sent when a tracking number is added.",
    variables: ["first_name", "order_number", "business_name", "tracking_number", "tracking_url", "sign_off"],
  },
  photo_reminder: {
    label: "Photo reminder",
    description: "Goes out by itself two days after the photo request if no photos arrived.",
    variables: ["first_name", "order_number", "business_name", "upload_link", "sign_off"],
  },
  proof_reminder: {
    label: "Proof reminder",
    description: "Print and ship orders only: sent three days after a proof if the customer has not answered. Digital orders get no reminder, and nothing is printed until the customer approves.",
    variables: ["first_name", "order_number", "business_name", "proof_link", "sign_off"],
  },
  photo_shortfall: {
    label: "More photos needed",
    description: "Drafted by the agent when an order has fewer photos than people or pets ordered. Waits for approval.",
    variables: ["first_name", "order_number", "business_name", "photos_have", "photos_need", "photos_have_noun", "photos_need_words", "photos_need_all", "upload_link", "sign_off"],
  },
  photo_subject_ask: {
    label: "Clear face photo needed",
    description:
      "Goes out once by itself when a pet or person on the order has no clear face photo yet, naming who. The designer cannot hand the portrait in until the photo arrives or someone marks the photo fine.",
    variables: ["first_name", "order_number", "business_name", "photos_have", "photos_have_noun", "subject_names", "subject_missing_faces", "subject_add_line", "upload_link", "sign_off"],
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
  "photo_shortfall",
  "photo_subject_ask",
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

/**
 * ONE PERSON SIGNS EVERY BUYER EMAIL (Yousif 2026-10-28, reply swipe file: "Sometimes you say 'Your artist' but it
 * doesn't work because the idea is that Mel is the artist"). Each shop talks to buyers as one person, the same one who
 * answers on Etsy, and that person IS the artist: emails were signed "The Custom Portrait Shop team" and spoke of "our
 * artist", then Mel answered the buyer's reply. The shop's own replySignOff (Settings > Agent) wins; this is the
 * persona when it is unset. A business that is none of these signs with its name alone, never "the team".
 */
const PERSONA_SIGN_OFF: Record<string, string> = {
  cps: "Kindest Regards,\nMel",
  perfetta: "Kindest Regards,\nMel",
  dt: "Best Regards,\nMel",
  pixart: "Kindest Regards,\nBrianna",
  ap: "Kindest Regards,\nBrianna",
  rsp: "Kindest Regards,\nAysha",
  aps: "Best Regards,\nAiya",
};
const PERSONA_BY_NAME: [RegExp, string][] = [
  [/custom portrait shop/i, "cps"],
  [/perfetta/i, "perfetta"],
  [/design therapy/i, "dt"],
  [/pixart/i, "pixart"],
  [/anime portrait/i, "aps"],
  [/artisan portraits?/i, "ap"],
  [/ready\s*set\s*portraits?/i, "rsp"],
];

/** The closing lines a business's buyer emails end with (the {{sign_off}} variable). */
export function signOffFor(business: { name?: string | null; slug?: string | null; replySignOff?: string | null }): string {
  const own = business.replySignOff?.trim();
  if (own) return own;
  const slug = business.slug && PERSONA_SIGN_OFF[business.slug] ? business.slug : PERSONA_BY_NAME.find(([re]) => re.test(business.name ?? ""))?.[1];
  if (slug) return PERSONA_SIGN_OFF[slug];
  const name = (business.name ?? "").trim();
  return name ? `Warm regards,\n${name}` : "Warm regards";
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/**
 * The photo-count email in words a person writes (same swipe file: "we have 1 photo(s) so far" read like a form):
 * photos_have_noun "photo" / "photos", photos_need_words "two", photos_need_all "both of them" / "all three of them".
 * Values the caller already set are kept.
 */
export function withPhotoWords(vars: TemplateVars): TemplateVars {
  const have = Number(vars.photos_have), need = Number(vars.photos_need);
  const out: TemplateVars = { ...vars };
  if (out.photos_have_noun === undefined && vars.photos_have !== undefined) out.photos_have_noun = have === 1 ? "photo" : "photos";
  if (Number.isInteger(need) && need >= 0 && vars.photos_need !== undefined) {
    const words = NUMBER_WORDS[need] ?? String(need);
    if (out.photos_need_words === undefined) out.photos_need_words = words;
    if (out.photos_need_all === undefined) out.photos_need_all = need === 2 ? "both of them" : need === 1 ? "them" : `all ${words} of them`;
  }
  return out;
}

/** Sample values for a preview or a test email: what a customer would see. */
export function sampleTemplateVars(businessName: string, appOrigin: string): TemplateVars {
  return withPhotoWords({
    first_name: "Sam",
    order_number: "TEST-1001",
    business_name: businessName,
    proof_link: `${appOrigin}/proof/sample-test`,
    upload_link: `${appOrigin}/upload/sample-test`,
    tracking_number: "TEST123456789",
    tracking_url: "https://example.com/track/TEST123456789",
    photos_have: "1",
    photos_need: "3",
    subject_names: "Jax and Rambo",
    subject_missing_faces: "a clear photo of Rambo's face",
    subject_add_line: "If you have one, you can add it here:",
    sign_off: signOffFor({ name: businessName }),
  });
}

/** Substitute {{placeholders}}; a placeholder with no value renders empty. */
export function fillTemplate(template: EmailTemplate, vars: TemplateVars): EmailTemplate {
  const sub = (input: string) =>
    input.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => (vars as Record<string, string | undefined>)[name] ?? "");
  return { subject: sub(template.subject), body: sub(template.body) };
}
