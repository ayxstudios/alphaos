import type { Role } from "@/lib/auth/config";

/**
 * Quick guide answers (/help). Each one is drawn from how the app really
 * behaves: the order flow in lib/orders/transitions.ts, the QC screen
 * (components/qc), Messages (components/emails) and docs/PROGRESS.md.
 * Plain English, second person, no internal names.
 */
export type GuideAnswer = { q: string; a: string };

const CUSTOMER_REPLIED: GuideAnswer = {
  q: "A customer replied, what do I do?",
  a: "Replies that match an order show on that order. Anything under Needs you in Messages has no order yet: open it, link it to the right order, then answer from the order. If they are answering their proof, record whether they approved it or want changes.",
};

const NEEDS_DETAILS: GuideAnswer = {
  q: "An order says Needs details",
  a: "The shop did not send everything a designer needs. In Orders, open Needs details and press Details. Fill in how many people or pets, the style and the photos, then save. With photos it goes to a designer. Without them it waits for the customer.",
};

const PASS_FAIL: GuideAnswer = {
  q: "How do I pass or fail QC?",
  a: "Open QC and press Start QC. Look at the customer photo and the portrait side by side. Tap each line that looks right, or the cross if something is wrong. Sign your name. Pass shows you the customer email before it sends. Fail asks what is wrong, then sends it back to the designer.",
};

const UPLOAD_STAFF: GuideAnswer = {
  q: "Where do I upload the finished portrait?",
  a: "The designer adds it on their board, then it comes to QC. The QC screen shows every version, newest first.",
};

const AWAITING_APPROVAL: GuideAnswer = {
  q: "What does Awaiting approval mean?",
  a: "The portrait passed QC and the customer got a link to see it. It waits until they approve it or ask for changes. Changes go back to the designer. Once approved, a printed order goes to Print and a digital one can be finished.",
};

const LATE: GuideAnswer = {
  q: "An order is late, what should I do?",
  a: "The Overdue tab in Orders lists them, worst first. Open the order to see who has it and what it is waiting for. If the designer cannot finish in time, give it to someone else from the order page.",
};

const PRINT: GuideAnswer = {
  q: "How do I send an order to print?",
  a: "Approved printed orders wait in Print, oldest first. Order it on the print company's site, then press Sent to print here. When the tracking number comes, add it on the same row.",
};

const ROSTER: GuideAnswer = {
  q: "How are new orders shared out?",
  a: "New orders go down the Designers list from the top, only to designers who draw that style, and never past their daily limit. Change the order, styles and limits on Designers. That page also adds people, resets passwords and turns off anyone who leaves (their history stays).",
};

const DESIGNER: GuideAnswer[] = [
  {
    q: "Where do I upload the finished portrait?",
    a: "Open the card on My Board and tap Start if it is new. Then tap the Finished portrait area and pick the file (on a laptop you can drop it there). QC checks the newest version.",
  },
  {
    q: "How do I send my work to QC?",
    a: "Once the portrait is added, press Submit for QC on the card. On a laptop you can also drag the card to Awaiting QC.",
  },
  {
    q: "My portrait came back. What now?",
    a: "It moves to Failed QC or Revisions, with a note on the card saying what to change. Add a new version, then submit it for QC again.",
  },
  {
    q: "What does With the Customer mean?",
    a: "Your portrait passed QC and the customer has a link to see it. Nothing to do unless they ask for changes. Then it comes back under Revisions.",
  },
  {
    q: "I started an order by mistake",
    a: "On a laptop, drag it back to My Queue (this also works for a card sent to QC too early). On a phone, ask your VA to move it back.",
  },
  {
    q: "Where do I see what I have earned?",
    a: "Home and My Week show this week and this month. My Board also has an Earnings history list at the bottom.",
  },
];

export const GUIDE_ANSWERS: Record<Role, GuideAnswer[]> = {
  va: [CUSTOMER_REPLIED, NEEDS_DETAILS, PASS_FAIL, UPLOAD_STAFF, AWAITING_APPROVAL, LATE, PRINT],
  admin: [CUSTOMER_REPLIED, NEEDS_DETAILS, PASS_FAIL, UPLOAD_STAFF, AWAITING_APPROVAL, LATE, PRINT, ROSTER],
  designer: DESIGNER,
};
